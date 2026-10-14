/**
 * Admin operations behind `sayl-admin`. They run in their own process on the
 * VPS, against the same database and qBittorrent as the server; the server's
 * next poll (within a second) picks up the changes.
 */
import { isIP } from 'node:net';
import type { Db } from './db.js';
import { ownerTag } from './engine.js';
import type { QbitClient, QbitPeer } from './qbit.js';
import { isInfoHash, parseMagnet } from './torrent-input.js';

export class AdminError extends Error {}

/** Accepts a 40-character hash in any case, or a magnet link. */
export function normaliseHash(input: string): string {
  const s = input.trim();
  if (/^magnet:/i.test(s)) return parseMagnet(s).infoHash;
  const h = s.toLowerCase();
  if (!isInfoHash(h)) throw new AdminError(`"${input}" isn't a 40-character info hash or a magnet link`);
  return h;
}

/** Removes a torrent for everyone, deletes its files, and stops it from being added again. */
export async function blockTorrent(db: Db, q: QbitClient, input: string, reason: string, now: number) {
  const hash = normaliseHash(input);
  db.block(hash, reason, now);
  const owners = db.ownersOf(hash).length;
  const inEngine = (await q.torrents([hash])).length > 0;
  if (inEngine) await q.delete([hash], true);
  db.deleteTorrent(hash);
  return { hash, owners, deleted: inEngine };
}

export function unblockTorrent(db: Db, input: string) {
  const hash = normaliseHash(input);
  return { hash, removed: db.unblock(hash) };
}

/** Bans an address from the API. With purge, also drops every torrent it added. */
export async function banIp(db: Db, q: QbitClient, ip: string, reason: string, now: number, purge: boolean) {
  if (!isIP(ip)) throw new AdminError(`"${ip}" isn't an IP address`);
  db.ban(ip, reason, now);
  let purged = 0;
  if (purge) {
    for (const o of db.ownershipsByIp(ip)) {
      const remaining = db.removeOwnership(o.hash, o.owner);
      const inEngine = (await q.torrents([o.hash])).length > 0;
      if (remaining === 0) {
        if (inEngine) await q.delete([o.hash], true);
        db.deleteTorrent(o.hash);
      } else if (inEngine) {
        await q.removeTags([o.hash], [ownerTag(o.owner)]);
      }
      purged++;
    }
  }
  return { ip, purged };
}

export function unbanIp(db: Db, ip: string) {
  if (!isIP(ip)) throw new AdminError(`"${ip}" isn't an IP address`);
  return { ip, removed: db.unban(ip) };
}

export interface TorrentRow {
  hash: string;
  name: string;
  state: string;
  size: number;
  progress: number;
  uploaded: number;
  ratio: number;
  upSpeed: number;
  peers: number;
  owners: { ip: string; addedAt: number; completedAt: number | null }[];
}

export async function listTorrents(db: Db, q: QbitClient): Promise<TorrentRow[]> {
  const engine = new Map((await q.torrents()).map((t) => [t.hash, t]));
  return db.torrentHashes().map((hash) => {
    const t = engine.get(hash);
    return {
      hash,
      name: t?.name || db.torrentName(hash) || hash,
      state: t?.state ?? 'missing',
      size: t ? Math.max(0, t.size) : 0,
      progress: t?.progress ?? 0,
      uploaded: t?.uploaded ?? 0,
      ratio: t?.ratio ?? 0,
      upSpeed: t?.upspeed ?? 0,
      peers: (t?.num_leechs ?? 0) + (t?.num_seeds ?? 0),
      owners: db.ownersOf(hash).map((o) => ({ ip: o.ip, addedAt: o.addedAt, completedAt: o.completedAt })),
    };
  });
}

/** The peers connected to one torrent, busiest uploads first. */
export async function torrentPeers(q: QbitClient, input: string): Promise<{ hash: string; name: string; state: string; uploaded: number; upSpeed: number; peers: QbitPeer[] }> {
  const hash = normaliseHash(input);
  const [t] = await q.torrents([hash]);
  if (!t) throw new AdminError(`${hash} isn't on the server`);
  const peers = (await q.peers(hash)) ?? [];
  peers.sort((a, b) => b.up_speed - a.up_speed || b.uploaded - a.uploaded);
  return { hash, name: t.name, state: t.state, uploaded: t.uploaded, upSpeed: t.upspeed, peers };
}
