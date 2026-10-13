/**
 * Keeps qBittorrent in line with what Sayl's users asked for.
 *
 * Every second it polls qBittorrent, then for each torrent:
 * - downloads only the union of files its owners picked (others get priority 0),
 * - runs it while any owner still needs it (unfinished, or seeding within limits),
 * - records when each owner's own selection finished.
 *
 * Every operation runs one at a time, so polls and user actions never interleave.
 */
import { EventEmitter } from 'node:events';
import { statfs } from 'node:fs/promises';
import type { Config } from './config.js';
import type { Db, Ownership } from './db.js';
import { ApiError, badRequest, conflict, notFound, tooLarge } from './errors.js';
import { tagList, type AddSource, type QbitClient, type QbitFile, type QbitTorrent } from './qbit.js';
import { isInfoHash } from './torrent-input.js';

export type ViewState = 'metadata' | 'selecting' | 'queued' | 'downloading' | 'stalled' | 'checking' | 'paused' | 'seeding' | 'done' | 'error';

export interface TorrentView {
  hash: string;
  name: string;
  state: ViewState;
  /** 0..1 over the files this owner picked. */
  progress: number;
  totalSize: number | null;
  selectedSize: number | null;
  downloaded: number;
  dlSpeed: number;
  upSpeed: number;
  /** seconds, or null when unknown */
  eta: number | null;
  peers: number;
  seeds: number;
  ratio: number;
  fileCount: number | null;
  paused: boolean;
  seed: boolean;
  ratioLimit: number;
  sequential: boolean;
  addedAt: number;
  completedAt: number | null;
  seedEndsAt: number | null;
}

export interface FileView {
  index: number;
  path: string;
  size: number;
  progress: number;
  /** null until the owner has picked files */
  selected: boolean | null;
}

export interface NewTorrent {
  infoHash: string;
  name: string | null;
  source: AddSource;
}

export interface SelectOptions {
  files: number[];
  seed?: boolean;
  sequential?: boolean;
  ratioLimit?: number;
}

/** How long a torrent may exist in qBittorrent without a database row (or the reverse) before cleanup removes it. */
const ORPHAN_GRACE_SECONDS = 600;

/** qBittorrent tag marking a torrent as owned by a session. */
export const ownerTag = (owner: string) => `owner-${owner}`;

const isStopped = (s: string) => s.startsWith('stopped') || s.startsWith('paused');
const isChecking = (s: string) => s.startsWith('checking');
const isError = (s: string) => s === 'error' || s === 'missingFiles';

function selectionProgress(selected: number[], files: QbitFile[]): { done: number; size: number } {
  let done = 0;
  let size = 0;
  for (const i of selected) {
    const f = files[i];
    if (!f) continue;
    size += f.size;
    done += f.size * f.progress;
  }
  return { done, size };
}

export class Engine extends EventEmitter {
  private torrents = new Map<string, QbitTorrent>();
  private files = new Map<string, QbitFile[]>();
  private chain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly q: QbitClient,
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly now: () => number = Date.now,
    private readonly onError: (err: unknown) => void = () => {},
    /** Free bytes on the downloads disk, or null if unknown. */
    private readonly diskFree: () => Promise<number | null> = async () => {
      try {
        const s = await statfs(cfg.DOWNLOADS_DIR);
        return s.bavail * s.bsize;
      } catch {
        return null;
      }
    },
  ) {
    super();
    this.setMaxListeners(0);
  }

  /** Runs fn after every earlier engine operation has finished. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  start(intervalMs = 1000): void {
    this.stopped = false;
    const loop = async () => {
      try {
        await this.tick();
      } catch (err) {
        this.onError(err);
      }
      if (!this.stopped) this.timer = setTimeout(loop, intervalMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One poll-and-reconcile pass. */
  tick(): Promise<void> {
    return this.exclusive(async () => {
      await this.refresh();
      for (const hash of this.db.torrentHashes()) await this.reconcile(hash);
      await this.cleanup();
      this.emit('update');
    });
  }

  private async refresh(hashes?: string[]): Promise<void> {
    const list = await this.q.torrents(hashes);
    const seen = new Set(list.map((t) => t.hash));
    const stale = hashes ?? [...this.torrents.keys()];
    for (const h of stale) {
      if (!seen.has(h)) {
        this.torrents.delete(h);
        this.files.delete(h);
      }
    }
    for (const t of list) {
      this.torrents.set(t.hash, t);
      if (!t.has_metadata) continue;
      const cached = this.files.get(t.hash);
      const stale = !cached || t.progress < 1 || isChecking(t.state) || cached.some((f) => f.priority > 0 && f.progress < 1);
      if (stale) {
        const files = await this.q.files(t.hash);
        if (files) this.files.set(t.hash, files);
      }
    }
  }

  private seedingActive(o: Ownership, t: QbitTorrent): boolean {
    return (
      o.seed && o.completedAt !== null && this.now() < o.completedAt + this.cfg.SEED_MAX_MINUTES * 60_000 && t.ratio < o.ratioLimit
    );
  }

  private async reconcile(hash: string): Promise<void> {
    const owners = this.db.ownersOf(hash);
    const t = this.torrents.get(hash);
    if (!owners.length || !t) return;

    if (!t.has_metadata) {
      // a magnet still looking for metadata must run to find it
      if (isStopped(t.state)) await this.q.start([hash]);
      return;
    }
    if (t.name && this.db.torrentName(hash) !== t.name) this.db.setTorrentName(hash, t.name);
    const files = this.files.get(hash);
    if (!files) return;

    // download only what someone picked
    const union = new Set(owners.flatMap((o) => o.selected ?? []));
    const off = files.filter((f) => !union.has(f.index) && f.priority !== 0).map((f) => f.index);
    const on = files.filter((f) => union.has(f.index) && f.priority === 0).map((f) => f.index);
    if (off.length) {
      await this.q.setFilePriority(hash, off, 0);
      for (const i of off) files[i]!.priority = 0;
    }
    if (on.length) {
      await this.q.setFilePriority(hash, on, 1);
      for (const i of on) files[i]!.priority = 1;
    }

    const now = this.now();
    for (const o of owners) {
      if (!o.selected || o.completedAt !== null) continue;
      const p = selectionProgress(o.selected, files);
      if (p.size > 0 && p.done >= p.size) {
        this.db.setCompleted(hash, o.owner, now);
        o.completedAt = now;
      }
    }

    const wantSequential = owners.some((o) => o.selected && o.sequential);
    if (t.seq_dl !== wantSequential) {
      await this.q.toggleSequential([hash]);
      t.seq_dl = wantSequential;
    }

    const wantRun = owners.some((o) => o.selected && !o.paused && (o.completedAt === null || this.seedingActive(o, t)));
    if (wantRun && isStopped(t.state)) {
      await this.q.start([hash]);
      await this.refresh([hash]);
    } else if (!wantRun && !isStopped(t.state) && !isChecking(t.state)) {
      await this.q.stop([hash]);
      await this.refresh([hash]);
    }
  }

  /** Hours finished files are kept for a selection of this size. */
  keepHours(bytes: number): number {
    const tiers = this.cfg.RETENTION_TIERS;
    return (tiers.find((t) => bytes <= t.maxBytes) ?? tiers[tiers.length - 1]!).hours;
  }

  /**
   * Deletes what has outlived its welcome:
   * - an owner's finished files once their retention time is up,
   * - unfinished torrents with no progress for STALL_TIMEOUT_HOURS (paused,
   *   stuck on metadata or never started all count),
   * - torrents in qBittorrent that Sayl doesn't know about, and database rows
   *   for torrents qBittorrent no longer has.
   */
  private async cleanup(): Promise<void> {
    const now = this.now();
    const stallMs = this.cfg.STALL_TIMEOUT_HOURS * 3600_000;
    for (const o of this.db.allOwnerships()) {
      if (o.completedAt !== null) {
        if (now >= o.completedAt + this.keepHours(o.selectedSize) * 3600_000) await this.release(o.owner, o.hash);
        continue;
      }
      const files = this.files.get(o.hash);
      const done = o.selected && files ? Math.floor(selectionProgress(o.selected, files).done) : 0;
      if (done > o.progressBytes) this.db.setProgress(o.hash, o.owner, done, now);
      else if (now - o.progressAt >= stallMs) await this.release(o.owner, o.hash);
    }
    for (const [hash, t] of [...this.torrents]) {
      if (this.db.torrentAddedAt(hash) === null && Math.floor(now / 1000) - t.added_on > ORPHAN_GRACE_SECONDS) {
        await this.q.delete([hash], true);
        this.torrents.delete(hash);
        this.files.delete(hash);
      }
    }
    for (const hash of this.db.torrentHashes()) {
      const at = this.db.torrentAddedAt(hash);
      if (!this.torrents.has(hash) && at !== null && now - at > ORPHAN_GRACE_SECONDS * 1000) this.db.deleteTorrent(hash);
    }
  }

  /** Bytes reserved on disk: every file someone picked, counted once per torrent. */
  private reservedBytes(): number {
    let total = 0;
    for (const [hash, t] of this.torrents) {
      // the file cache holds priorities as Sayl last set them; qBittorrent's own total can lag a poll behind
      const files = this.files.get(hash);
      total += files ? files.reduce((sum, f) => sum + (f.priority > 0 ? f.size : 0), 0) : Math.max(0, t.size);
    }
    return total;
  }

  // ---- views -----------------------------------------------------------------

  private state(o: Ownership, t: QbitTorrent | undefined, progress: number): ViewState {
    if (!t || isError(t.state)) return 'error';
    if (!t.has_metadata) return 'metadata';
    if (!o.selected) return 'selecting';
    if (isChecking(t.state) || t.state === 'checkingResumeData') return 'checking';
    if (o.paused) return 'paused';
    if (progress >= 1 || o.completedAt !== null) return this.seedingActive(o, t) && !isStopped(t.state) ? 'seeding' : 'done';
    if (t.state === 'queuedDL' || isStopped(t.state)) return 'queued';
    if (t.state === 'stalledDL' || t.state === 'metaDL') return 'stalled';
    return 'downloading';
  }

  private view(o: Ownership): TorrentView {
    const t = this.torrents.get(o.hash);
    const files = this.files.get(o.hash);
    const sel = o.selected && files ? selectionProgress(o.selected, files) : null;
    const progress = sel && sel.size > 0 ? Math.min(1, sel.done / sel.size) : 0;
    const state = this.state(o, t, progress);
    const downloading = state === 'downloading' || state === 'stalled';
    const dlSpeed = downloading ? (t?.dlspeed ?? 0) : 0;
    const remaining = sel ? sel.size - sel.done : 0;
    return {
      hash: o.hash,
      name: (t?.has_metadata && t.name) || this.db.torrentName(o.hash) || o.hash,
      state,
      progress,
      totalSize: t?.has_metadata ? t.total_size : null,
      selectedSize: o.selected ? o.selectedSize : null,
      downloaded: sel ? Math.round(sel.done) : 0,
      dlSpeed,
      upSpeed: state === 'paused' || state === 'done' ? 0 : (t?.upspeed ?? 0),
      eta: downloading && dlSpeed > 0 ? Math.round(remaining / dlSpeed) : null,
      peers: t?.num_leechs ?? 0,
      seeds: t?.num_seeds ?? 0,
      ratio: t?.ratio ?? 0,
      fileCount: files?.length ?? null,
      paused: o.paused,
      seed: o.seed,
      ratioLimit: o.ratioLimit,
      sequential: o.sequential,
      addedAt: o.addedAt,
      completedAt: o.completedAt,
      seedEndsAt: o.seed && o.completedAt !== null ? o.completedAt + this.cfg.SEED_MAX_MINUTES * 60_000 : null,
    };
  }

  /**
   * The owner's row for this torrent, or 404. qBittorrent must also carry the
   * owner's tag; the database and the tag have to agree before anything is shown.
   */
  private owned(owner: string, hash: string): Ownership {
    if (!isInfoHash(hash)) throw notFound();
    const o = this.db.ownership(hash, owner);
    if (!o) throw notFound();
    const t = this.torrents.get(hash);
    if (t && !tagList(t.tags).includes(ownerTag(owner))) throw notFound();
    return o;
  }

  list(owner: string): TorrentView[] {
    return this.db
      .ownershipsOf(owner)
      .filter((o) => {
        const t = this.torrents.get(o.hash);
        return !t || tagList(t.tags).includes(ownerTag(owner));
      })
      .map((o) => this.view(o));
  }

  get(owner: string, hash: string): TorrentView {
    return this.view(this.owned(owner, hash));
  }

  async fileList(owner: string, hash: string): Promise<FileView[]> {
    const o = this.owned(owner, hash);
    let files = this.files.get(hash);
    if (!files) {
      const t = this.torrents.get(hash);
      if (!t?.has_metadata) throw conflict('still fetching the file list', 'no_metadata');
      files = (await this.q.files(hash)) ?? [];
      this.files.set(hash, files);
    }
    const picked = o.selected ? new Set(o.selected) : null;
    return files.map((f) => ({ index: f.index, path: f.name, size: f.size, progress: f.progress, selected: picked ? picked.has(f.index) : null }));
  }

  /** Completed files the owner picked, with their path inside the downloads folder. */
  completedFiles(owner: string, hash: string): { view: TorrentView; files: { index: number; path: string; size: number }[] } {
    const o = this.owned(owner, hash);
    const t = this.torrents.get(hash);
    const files = this.files.get(hash);
    if (!o.selected || !t || !files) return { view: this.view(o), files: [] };
    if (t.save_path.replace(/\/+$/, '') !== '/downloads') return { view: this.view(o), files: [] };
    const out = o.selected
      .map((i) => files[i])
      .filter((f): f is QbitFile => !!f && f.progress >= 1)
      .map((f) => ({ index: f.index, path: f.name, size: f.size }));
    return { view: this.view(o), files: out };
  }

  // ---- actions ---------------------------------------------------------------

  add(owner: string, ip: string, input: NewTorrent): Promise<TorrentView> {
    return this.exclusive(async () => {
      const hash = input.infoHash;
      const mine = this.db.ownership(hash, owner);
      if (mine) return this.view(mine);
      if (this.db.isBlocked(hash)) throw new ApiError(451, 'blocked', "this torrent was removed after a complaint and can't be added");
      const active = (list: Ownership[]) => list.filter((o) => o.completedAt === null).length;
      if (active(this.db.ownershipsOf(owner)) >= this.cfg.MAX_ACTIVE_PER_USER) {
        throw conflict(`you can have ${this.cfg.MAX_ACTIVE_PER_USER} unfinished torrents at once. wait for one to finish or remove one.`, 'too_many_active');
      }
      if (active(this.db.ownershipsByIp(ip)) >= this.cfg.MAX_ACTIVE_PER_IP) {
        throw conflict(`your network already has ${this.cfg.MAX_ACTIVE_PER_IP} unfinished torrents. wait for one to finish.`, 'too_many_active_ip');
      }
      const tag = ownerTag(owner);
      let known = this.torrents.has(hash) || (await this.q.torrents([hash])).length > 0;
      if (!known) known = !(await this.q.add(input.source, [tag]));
      if (known) await this.q.addTags([hash], [tag]);
      const now = this.now();
      this.db.upsertTorrent(hash, input.name ?? hash, now);
      this.db.addOwnership({ hash, owner, ip, addedAt: now, ratioLimit: this.cfg.DEFAULT_RATIO_LIMIT });
      // re-read it now so the new owner tag is in the cache before anyone acts on it
      await this.refresh([hash]);
      for (let i = 0; i < 20 && !this.torrents.has(hash); i++) {
        await new Promise((r) => setTimeout(r, 150));
        await this.refresh([hash]);
      }
      await this.reconcile(hash);
      this.emit('update');
      return this.view(this.db.ownership(hash, owner)!);
    });
  }

  select(owner: string, hash: string, opts: SelectOptions): Promise<TorrentView> {
    return this.exclusive(async () => {
      const o = this.owned(owner, hash);
      if (o.selected) throw conflict('files are already picked for this torrent', 'already_selected');
      const t = this.torrents.get(hash);
      const files = this.files.get(hash);
      if (!t?.has_metadata || !files) throw conflict('still fetching the file list', 'no_metadata');
      const picked = [...new Set(opts.files)].sort((a, b) => a - b);
      if (!picked.length) throw badRequest('pick at least one file', 'no_files');
      if (picked.some((i) => !Number.isInteger(i) || i < 0 || i >= files.length)) throw badRequest('that file selection is invalid', 'bad_files');
      const size = picked.reduce((sum, i) => sum + files[i]!.size, 0);
      if (size > this.cfg.MAX_TORRENT_SIZE_GB * 1e9) {
        throw tooLarge(`that's more than ${this.cfg.MAX_TORRENT_SIZE_GB} gb. pick fewer files.`, 'torrent_too_large');
      }
      const ratioLimit = opts.ratioLimit ?? this.cfg.DEFAULT_RATIO_LIMIT;
      if (!(ratioLimit >= 0.1 && ratioLimit <= 10)) throw badRequest('ratio limit must be between 0.1 and 10', 'bad_ratio');

      const stored = (list: Ownership[]) => list.reduce((sum, x) => sum + (x.selected ? x.selectedSize : 0), 0);
      const userCap = this.cfg.MAX_STORAGE_PER_USER_GB * 1e9;
      if (stored(this.db.ownershipsOf(owner)) + size > userCap) {
        throw conflict(`that would take you past ${this.cfg.MAX_STORAGE_PER_USER_GB} gb stored. remove something or pick fewer files.`, 'storage_full');
      }
      if (stored(this.db.ownershipsByIp(o.ip)) + size > this.cfg.MAX_STORAGE_PER_IP_GB * 1e9) {
        throw conflict(`your network is using its ${this.cfg.MAX_STORAGE_PER_IP_GB} gb. remove something or pick fewer files.`, 'storage_full_ip');
      }
      // only files nobody picked yet need new space
      const fresh = picked.map((i) => files[i]!).filter((f) => f.priority === 0);
      const extra = fresh.reduce((sum, f) => sum + f.size, 0);
      if (this.reservedBytes() + extra > this.cfg.GLOBAL_STORAGE_CAP_GB * 1e9) {
        throw conflict("the server is full right now. try again in a few hours, when older files expire.", 'server_full');
      }
      const free = await this.diskFree();
      const needed = fresh.reduce((sum, f) => sum + f.size * (1 - f.progress), 0);
      if (free !== null && needed + this.cfg.DISK_RESERVE_GB * 1e9 > free) {
        throw conflict("the server is full right now. try again in a few hours, when older files expire.", 'server_full');
      }
      this.db.select(hash, owner, {
        files: picked,
        size,
        seed: opts.seed ?? false,
        sequential: opts.sequential ?? false,
        ratioLimit,
        now: this.now(),
      });
      await this.reconcile(hash);
      this.emit('update');
      return this.view(this.db.ownership(hash, owner)!);
    });
  }

  private ownerAction(owner: string, hash: string, fn: (o: Ownership) => Promise<void> | void): Promise<TorrentView> {
    return this.exclusive(async () => {
      const o = this.owned(owner, hash);
      await fn(o);
      await this.reconcile(hash);
      this.emit('update');
      return this.view(this.db.ownership(hash, owner)!);
    });
  }

  pause(owner: string, hash: string) {
    return this.ownerAction(owner, hash, (o) => {
      if (!o.selected) throw conflict('pick files first', 'not_started');
      this.db.setPaused(hash, owner, true);
    });
  }

  resume(owner: string, hash: string) {
    return this.ownerAction(owner, hash, (o) => {
      if (!o.selected) throw conflict('pick files first', 'not_started');
      this.db.setPaused(hash, owner, false);
    });
  }

  recheck(owner: string, hash: string) {
    return this.ownerAction(owner, hash, async () => {
      if (!this.torrents.get(hash)?.has_metadata) throw conflict('still fetching the file list', 'no_metadata');
      await this.q.recheck([hash]);
      const t = this.torrents.get(hash);
      if (t) t.state = 'checkingDL';
    });
  }

  /** Stops seeding for this owner and keeps the files downloadable until they expire. */
  stopSeeding(owner: string, hash: string) {
    return this.ownerAction(owner, hash, (o) => {
      if (o.completedAt === null) throw conflict("it hasn't finished yet. remove it instead.", 'not_finished');
      this.db.setSeed(hash, owner, false);
    });
  }

  /** Drops the owner's claim. The data is deleted once nobody owns the torrent. */
  remove(owner: string, hash: string): Promise<void> {
    return this.exclusive(async () => {
      this.owned(owner, hash);
      await this.release(owner, hash);
      this.emit('update');
    });
  }

  removeAll(owner: string): Promise<number> {
    return this.exclusive(async () => {
      const mine = this.db.ownershipsOf(owner);
      for (const o of mine) await this.release(owner, o.hash);
      this.emit('update');
      return mine.length;
    });
  }

  private async release(owner: string, hash: string): Promise<void> {
    const remaining = this.db.removeOwnership(hash, owner);
    const t = this.torrents.get(hash);
    if (remaining === 0) {
      if (t) await this.q.delete([hash], true);
      this.db.deleteTorrent(hash);
      this.torrents.delete(hash);
      this.files.delete(hash);
      return;
    }
    if (t) await this.q.removeTags([hash], [ownerTag(owner)]);
    if (t) t.tags = tagList(t.tags).filter((x) => x !== ownerTag(owner)).join(', ');
    await this.reconcile(hash);
  }
}
