/**
 * SQLite storage (Node's built-in node:sqlite, no native modules).
 *
 * A torrent can be owned by several sessions: qBittorrent holds one copy per
 * info hash, so when two people add the same torrent they share the data.
 * Each owner has their own row with their own file selection and settings.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface Ownership {
  hash: string;
  owner: string;
  ip: string;
  addedAt: number;
  /** File indexes the owner picked, or null while they haven't picked yet. */
  selected: number[] | null;
  selectedSize: number;
  paused: boolean;
  seed: boolean;
  ratioLimit: number;
  sequential: boolean;
  startedAt: number | null;
  completedAt: number | null;
}

interface OwnershipRow {
  hash: string;
  owner: string;
  ip: string;
  added_at: number;
  selected: string | null;
  selected_size: number;
  paused: number;
  seed: number;
  ratio_limit: number;
  sequential: number;
  started_at: number | null;
  completed_at: number | null;
}

const toOwnership = (r: OwnershipRow): Ownership => ({
  hash: r.hash,
  owner: r.owner,
  ip: r.ip,
  addedAt: r.added_at,
  selected: r.selected === null ? null : (JSON.parse(r.selected) as number[]),
  selectedSize: r.selected_size,
  paused: r.paused === 1,
  seed: r.seed === 1,
  ratioLimit: r.ratio_limit,
  sequential: r.sequential === 1,
  startedAt: r.started_at,
  completedAt: r.completed_at,
});

const MIGRATIONS = [
  `CREATE TABLE torrents (
     hash TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     added_at INTEGER NOT NULL
   );
   CREATE TABLE ownerships (
     hash TEXT NOT NULL REFERENCES torrents(hash) ON DELETE CASCADE,
     owner TEXT NOT NULL,
     ip TEXT NOT NULL,
     added_at INTEGER NOT NULL,
     selected TEXT,
     selected_size INTEGER NOT NULL DEFAULT 0,
     paused INTEGER NOT NULL DEFAULT 0,
     seed INTEGER NOT NULL DEFAULT 0,
     ratio_limit REAL NOT NULL,
     sequential INTEGER NOT NULL DEFAULT 0,
     started_at INTEGER,
     completed_at INTEGER,
     PRIMARY KEY (hash, owner)
   );
   CREATE INDEX ownerships_owner ON ownerships(owner);
   CREATE INDEX ownerships_ip ON ownerships(ip);`,
];

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const version = (this.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.sql.exec('BEGIN');
      try {
        this.sql.exec(MIGRATIONS[v]!);
        this.sql.exec(`PRAGMA user_version = ${v + 1}`);
        this.sql.exec('COMMIT');
      } catch (err) {
        this.sql.exec('ROLLBACK');
        throw err;
      }
    }
  }

  close(): void {
    this.sql.close();
  }

  upsertTorrent(hash: string, name: string, now: number): void {
    this.sql.prepare('INSERT INTO torrents (hash, name, added_at) VALUES (?, ?, ?) ON CONFLICT(hash) DO NOTHING').run(hash, name, now);
  }

  setTorrentName(hash: string, name: string): void {
    this.sql.prepare('UPDATE torrents SET name = ? WHERE hash = ?').run(name, hash);
  }

  torrentName(hash: string): string | null {
    const r = this.sql.prepare('SELECT name FROM torrents WHERE hash = ?').get(hash) as { name: string } | undefined;
    return r?.name ?? null;
  }

  torrentHashes(): string[] {
    return (this.sql.prepare('SELECT hash FROM torrents').all() as { hash: string }[]).map((r) => r.hash);
  }

  deleteTorrent(hash: string): void {
    this.sql.prepare('DELETE FROM torrents WHERE hash = ?').run(hash);
  }

  addOwnership(o: { hash: string; owner: string; ip: string; addedAt: number; ratioLimit: number }): void {
    this.sql
      .prepare('INSERT INTO ownerships (hash, owner, ip, added_at, ratio_limit) VALUES (?, ?, ?, ?, ?)')
      .run(o.hash, o.owner, o.ip, o.addedAt, o.ratioLimit);
  }

  ownership(hash: string, owner: string): Ownership | null {
    const r = this.sql.prepare('SELECT * FROM ownerships WHERE hash = ? AND owner = ?').get(hash, owner) as OwnershipRow | undefined;
    return r ? toOwnership(r) : null;
  }

  ownershipsOf(owner: string): Ownership[] {
    return (this.sql.prepare('SELECT * FROM ownerships WHERE owner = ? ORDER BY added_at DESC, hash').all(owner) as unknown as OwnershipRow[]).map(toOwnership);
  }

  ownersOf(hash: string): Ownership[] {
    return (this.sql.prepare('SELECT * FROM ownerships WHERE hash = ? ORDER BY added_at, owner').all(hash) as unknown as OwnershipRow[]).map(toOwnership);
  }

  select(hash: string, owner: string, s: { files: number[]; size: number; seed: boolean; ratioLimit: number; sequential: boolean; now: number }): void {
    this.sql
      .prepare(
        'UPDATE ownerships SET selected = ?, selected_size = ?, seed = ?, ratio_limit = ?, sequential = ?, started_at = ? WHERE hash = ? AND owner = ?',
      )
      .run(JSON.stringify(s.files), s.size, s.seed ? 1 : 0, s.ratioLimit, s.sequential ? 1 : 0, s.now, hash, owner);
  }

  setPaused(hash: string, owner: string, paused: boolean): void {
    this.sql.prepare('UPDATE ownerships SET paused = ? WHERE hash = ? AND owner = ?').run(paused ? 1 : 0, hash, owner);
  }

  setSeed(hash: string, owner: string, seed: boolean): void {
    this.sql.prepare('UPDATE ownerships SET seed = ? WHERE hash = ? AND owner = ?').run(seed ? 1 : 0, hash, owner);
  }

  setCompleted(hash: string, owner: string, at: number): void {
    this.sql.prepare('UPDATE ownerships SET completed_at = ? WHERE hash = ? AND owner = ? AND completed_at IS NULL').run(at, hash, owner);
  }

  removeOwnership(hash: string, owner: string): number {
    this.sql.prepare('DELETE FROM ownerships WHERE hash = ? AND owner = ?').run(hash, owner);
    return (this.sql.prepare('SELECT COUNT(*) AS n FROM ownerships WHERE hash = ?').get(hash) as { n: number }).n;
  }
}
