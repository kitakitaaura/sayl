/**
 * The browser engine: torrents run in this tab, through the visitor's relay,
 * and their files land in the browser's private storage (OPFS) until saved.
 *
 * It keeps the same TorrentView/FileView shapes the server API returns, so the
 * cards and dialogs work unchanged. Torrents and progress are remembered in
 * localStorage; on reload, unfinished downloads pick up where they left off.
 */
import {
  Download,
  equalBytes,
  fetchTurnServers,
  fileProgress,
  parseInfo,
  parseMagnet,
  parseTorrentFile,
  pieceSegments,
  piecesForFiles,
  safePathParts,
  sha1,
  type Info,
  type Summary,
} from '$bt';
import type { FileView, Links, TorrentView } from '$lib/api';
import { relayConfig } from './relay.svelte';
import { StorageError, finishedFile, storage } from './storage';

const RECORDS_KEY = 'sayl.torrents';
/** Downloads running at once; the rest wait their turn. */
const MAX_RUNNING = 3;
const MAX_TORRENT_FILE = 4 * 1024 * 1024;
/** Kept free on top of a download's size, so the browser doesn't fill up to the last byte. */
const STORAGE_MARGIN = 64 * 1024 * 1024;

export class EngineError extends Error {}

/** What's remembered about a torrent between visits. */
interface Rec {
  hash: string;
  name: string;
  trackers: string[];
  peers: string[];
  addedAt: number;
  hasInfo: boolean;
  /** file indexes to download, or null until chosen */
  selected: number[] | null;
  sequential: boolean;
  /** verified pieces, packed one bit per piece, base64 */
  have: string | null;
  completedAt: number | null;
  paused: boolean;
  error: string | null;
}

interface Item {
  rec: Rec;
  info: Info | null;
  /** 1 per verified piece */
  have: Uint8Array | null;
  wanted: Uint8Array | null;
  /** each file's storage path parts, unique within the torrent */
  paths: string[][] | null;
  /** bytes of the chosen files that are verified */
  doneBytes: number;
  dl: Download | null;
  /** set while a download is being prepared, before `dl` exists */
  starting: boolean;
  dlStartedAt: number;
  checking: number | null;
  speed: number;
  peers: number;
  seeds: number;
  /** start every file as soon as the metadata arrives (the "select files" chip was off) */
  autoSelect: { sequential: boolean } | null;
  links: string[];
}

const pack = (have: Uint8Array): string => {
  const bits = new Uint8Array(Math.ceil(have.length / 8));
  for (let i = 0; i < have.length; i++) if (have[i]) bits[i >> 3] |= 0x80 >> (i & 7);
  let s = '';
  for (const b of bits) s += String.fromCharCode(b);
  return btoa(s);
};

const unpack = (packed: string, count: number): Uint8Array => {
  const have = new Uint8Array(count);
  try {
    const s = atob(packed);
    for (let i = 0; i < count; i++) if (s.charCodeAt(i >> 3) & (0x80 >> (i & 7))) have[i] = 1;
  } catch {
    // corrupt: start over, a recheck fixes it
  }
  return have;
};

/** Storage paths for every file, made unique if two names clean up to the same thing. */
function layoutFor(info: Info): string[][] {
  const used = new Set<string>();
  return info.files.map((f, i) => {
    let parts = safePathParts(info.files.length === 1 ? info.name : f.path);
    let key = parts.join('/').toLowerCase();
    if (used.has(key)) {
      const last = parts[parts.length - 1];
      const dot = last.lastIndexOf('.');
      const renamed = dot > 0 ? `${last.slice(0, dot)} (${i})${last.slice(dot)}` : `${last} (${i})`;
      parts = [...parts.slice(0, -1), renamed];
      key = parts.join('/').toLowerCase();
    }
    used.add(key);
    return parts;
  });
}

function friendlyStorageError(err: unknown): string {
  if (err instanceof StorageError && err.name === 'QuotaExceededError') return "your browser ran out of storage space for this download. free some up, or pick fewer files.";
  return `couldn't save to your browser's storage: ${err instanceof Error ? err.message : String(err)}`;
}

export class BrowserEngine {
  private items = new Map<string, Item>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onchange: (views: TorrentView[]) => void) {}

  // ── lifecycle ─────────────────────────────────────────────────────────

  async load(): Promise<void> {
    let recs: Rec[] = [];
    try {
      recs = JSON.parse(localStorage.getItem(RECORDS_KEY) ?? '[]') as Rec[];
    } catch {
      recs = [];
    }
    for (const rec of recs) {
      if (!rec || typeof rec.hash !== 'string' || !/^[0-9a-f]{40}$/.test(rec.hash)) continue;
      const item = this.blank(rec);
      if (rec.hasInfo) {
        try {
          const raw = await storage.loadInfo(rec.hash);
          if (raw) this.setInfo(item, parseInfo(raw));
        } catch {
          // fall back to fetching the metadata again
        }
        if (!item.info) rec.hasInfo = false;
      }
      if (item.info && rec.have) item.have = unpack(rec.have, item.info.pieceCount);
      if (item.info && rec.selected) this.applySelection(item, rec.selected);
      this.items.set(rec.hash, item);
    }
    this.emit();
    this.schedule();
  }

  /** Saves progress right away (the page is closing). */
  flush(): void {
    this.save();
  }

  /** True while something is downloading, so the page can warn before closing. */
  get busy(): boolean {
    for (const item of this.items.values()) if ((item.dl || item.starting) && item.rec.selected && !item.rec.completedAt) return true;
    return false;
  }

  /** Called when the relay settings change. */
  relayChanged(): void {
    for (const item of this.items.values()) {
      const d = item.dl;
      item.dl = null; // so stopped() doesn't mistake this for the download ending
      d?.stop('relay changed');
    }
    setTimeout(() => this.schedule(), 0);
  }

  private blank(rec: Rec): Item {
    return {
      rec,
      info: null,
      have: null,
      wanted: null,
      paths: null,
      doneBytes: 0,
      dl: null,
      starting: false,
      dlStartedAt: 0,
      checking: null,
      speed: 0,
      peers: 0,
      seeds: 0,
      autoSelect: null,
      links: [],
    };
  }

  private setInfo(item: Item, info: Info): void {
    item.info = info;
    item.paths = layoutFor(info);
    item.have ??= new Uint8Array(info.pieceCount);
    item.rec.name = info.name;
  }

  private applySelection(item: Item, files: number[]): void {
    const info = item.info!;
    item.rec.selected = files.filter((i) => Number.isInteger(i) && i >= 0 && i < info.files.length);
    item.wanted = piecesForFiles(info, item.rec.selected);
    this.countDone(item);
  }

  private countDone(item: Item): void {
    if (!item.info || !item.have || !item.rec.selected) {
      item.doneBytes = 0;
      return;
    }
    const per = fileProgress(item.info, item.have);
    item.doneBytes = item.rec.selected.reduce((n, i) => n + per[i], 0);
  }

  private selectedSize(item: Item): number | null {
    if (!item.info || !item.rec.selected) return null;
    return item.rec.selected.reduce((n, i) => n + item.info!.files[i].length, 0);
  }

  // ── running downloads ─────────────────────────────────────────────────

  /** Starts what should run, up to MAX_RUNNING at once, oldest first. */
  private schedule(): void {
    const relay = relayConfig.relay();
    if (!relay) return;
    const items = [...this.items.values()].sort((a, b) => a.rec.addedAt - b.rec.addedAt);
    let running = items.filter((i) => i.dl || i.starting).length;
    for (const item of items) {
      if (running >= MAX_RUNNING) break;
      if (item.dl || item.starting || !this.shouldRun(item)) continue;
      running++;
      void this.start(item);
    }
  }

  private shouldRun(item: Item): boolean {
    const r = item.rec;
    if (r.paused || r.error || item.checking !== null) return false;
    if (!item.info) return true; // fetching the metadata
    if (!r.selected) return false; // waiting for the user to pick files
    return !r.completedAt;
  }

  private async start(item: Item): Promise<void> {
    const relay = relayConfig.relay();
    if (!relay) return;
    const { rec } = item;
    // claim the slot before the first await, so schedule() doesn't start this twice
    item.starting = true;
    if (item.info && rec.selected) {
      try {
        await this.prepare(item);
      } catch (err) {
        item.starting = false;
        rec.error = friendlyStorageError(err);
        this.changed(true);
        return;
      }
    }
    if (!item.starting) return; // removed, paused or rechecked meanwhile
    item.starting = false;
    if (!this.shouldRun(item)) {
      this.schedule();
      return;
    }
    const session = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    const d = new Download({
      relay: { ...relay, via: 'do', session },
      source: { infoHash: rec.hash, name: rec.name, trackers: rec.trackers, peers: rec.peers, info: item.info ?? undefined },
      sink: { write: (_offset, bytes, piece) => this.write(item, piece, bytes) },
      wanted: item.wanted ?? null,
      have: item.have,
      sequential: rec.sequential,
      maxPeers: 30,
      // the relay's own TURN login if it has one, otherwise this website's
      dht: { getTurn: () => fetchTurnServers(relay, { fallback: '/api/turn' }) },
    });
    item.dl = d;
    item.dlStartedAt = Date.now();
    d.onmetadata = (info) => void this.gotMetadata(item, d, info);
    d.onpiece = (piece) => this.gotPiece(item, piece);
    d.onprogress = (p) => {
      item.speed = p.bytesPerSecond;
      item.peers = p.peersConnected;
      item.seeds = p.seeds;
      this.emitSoon();
    };
    this.emit();
    const summary = await d.start();
    this.stopped(item, d, summary);
  }

  private async prepare(item: Item): Promise<void> {
    const info = item.info!;
    await storage.prepare(
      item.rec.hash,
      item.rec.selected!.map((i) => ({ index: i, parts: item.paths![i], length: info.files[i].length })),
    );
  }

  private async write(item: Item, piece: number, bytes: Uint8Array): Promise<void> {
    const info = item.info!;
    const chosen = new Set(item.rec.selected ?? []);
    const segments = pieceSegments(info, piece);
    const mine = segments.filter((s) => chosen.has(s.file)).map((s) => ({ index: s.file, fileOffset: s.fileOffset, pieceOffset: s.pieceOffset, length: s.length }));
    // A piece that also covers files the user didn't pick is kept whole, so a recheck can verify it.
    const part = segments.some((s) => !chosen.has(s.file));
    await storage.write(item.rec.hash, piece, bytes, mine, part);
  }

  private gotPiece(item: Item, piece: number): void {
    if (!item.have || !item.info) return;
    item.have[piece] = 1;
    const chosen = new Set(item.rec.selected ?? []);
    for (const s of pieceSegments(item.info, piece)) if (chosen.has(s.file)) item.doneBytes += s.length;
    this.changed(false);
  }

  private async gotMetadata(item: Item, d: Download, info: Info): Promise<void> {
    if (item.dl !== d) return;
    this.setInfo(item, info);
    item.rec.hasInfo = true;
    try {
      await storage.saveInfo(item.rec.hash, info.raw);
    } catch {
      item.rec.hasInfo = false; // fetched again next visit
    }
    this.changed(true);
    if (item.autoSelect) {
      const { sequential } = item.autoSelect;
      item.autoSelect = null;
      try {
        await this.select(item.rec.hash, info.files.map((_, i) => i), { sequential });
      } catch (err) {
        item.rec.error = err instanceof Error ? err.message : String(err);
        this.changed(true);
      }
    }
  }

  private stopped(item: Item, d: Download, summary: Summary): void {
    void storage.close(item.rec.hash).catch(() => {});
    if (item.dl !== d) return;
    item.dl = null;
    item.speed = 0;
    item.peers = 0;
    item.seeds = 0;
    const reason = summary.stopReason ?? '';
    if (reason === 'complete') {
      item.rec.completedAt ??= Date.now();
    } else if (reason.startsWith("couldn't save")) {
      item.rec.error = friendlyStorageError(new StorageError(/quota/i.test(reason) ? 'QuotaExceededError' : 'Error', reason));
    }
    this.changed(true);
    this.schedule();
  }

  // ── what the UI calls ─────────────────────────────────────────────────

  /** Adds a magnet link or a .torrent URL. */
  async add(source: string, autoSelect: { sequential: boolean } | null): Promise<TorrentView> {
    if (/^magnet:\?/i.test(source)) {
      let m: ReturnType<typeof parseMagnet>;
      try {
        m = parseMagnet(source);
      } catch (err) {
        throw new EngineError(err instanceof Error ? `${err.message}.` : 'that magnet link is not valid.');
      }
      const existing = this.items.get(m.infoHash);
      if (existing) return this.view(existing);
      const item = this.blank({
        hash: m.infoHash,
        name: m.name ?? m.infoHash,
        trackers: m.trackers,
        peers: m.peers,
        addedAt: Date.now(),
        hasInfo: false,
        selected: null,
        sequential: autoSelect?.sequential ?? false,
        have: null,
        completedAt: null,
        paused: false,
        error: null,
      });
      item.autoSelect = autoSelect;
      this.items.set(m.infoHash, item);
      this.changed(true);
      this.schedule();
      return this.view(item);
    }
    let res: Response;
    try {
      res = await fetch(source, { signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new EngineError("couldn't fetch that .torrent from here (the site may not allow it). download it and drop it in instead.");
    }
    if (!res.ok) throw new EngineError(`that address answered ${res.status}.`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_TORRENT_FILE) throw new EngineError('that .torrent file is too big.');
    return this.addTorrent(bytes, autoSelect);
  }

  /** Adds a .torrent file's contents. */
  async addTorrent(bytes: Uint8Array, autoSelect: { sequential: boolean } | null): Promise<TorrentView> {
    let t: Awaited<ReturnType<typeof parseTorrentFile>>;
    try {
      t = await parseTorrentFile(bytes);
    } catch {
      throw new EngineError("that isn't a valid .torrent file.");
    }
    const existing = this.items.get(t.infoHash);
    if (existing) return this.view(existing);
    const item = this.blank({
      hash: t.infoHash,
      name: t.info.name,
      trackers: t.trackers,
      peers: [],
      addedAt: Date.now(),
      hasInfo: true,
      selected: null,
      sequential: autoSelect?.sequential ?? false,
      have: null,
      completedAt: null,
      paused: false,
      error: null,
    });
    this.setInfo(item, t.info);
    try {
      await storage.saveInfo(t.infoHash, t.info.raw);
    } catch (err) {
      throw new EngineError(friendlyStorageError(err));
    }
    this.items.set(t.infoHash, item);
    this.changed(true);
    if (autoSelect) await this.select(t.infoHash, t.info.files.map((_, i) => i), autoSelect);
    return this.view(item);
  }

  has(hash: string): boolean {
    return this.items.has(hash);
  }

  files(hash: string): FileView[] {
    const item = this.need(hash);
    if (!item.info) throw new EngineError('the file list isn’t here yet.');
    const per = item.have ? fileProgress(item.info, item.have) : null;
    const chosen = item.rec.selected ? new Set(item.rec.selected) : null;
    return item.info.files.map((f, i) => ({
      index: i,
      path: item.info!.files.length === 1 ? item.info!.name : f.path,
      size: f.length,
      progress: f.length ? (per?.[i] ?? 0) / f.length : 1,
      selected: chosen ? chosen.has(i) : null,
    }));
  }

  async select(hash: string, files: number[], opts: { sequential: boolean }): Promise<TorrentView> {
    const item = this.need(hash);
    if (!item.info) throw new EngineError('wait for the file list first.');
    if (!files.length) throw new EngineError('pick at least one file.');
    const size = files.reduce((n, i) => n + (item.info!.files[i]?.length ?? 0), 0);
    const est = await navigator.storage?.estimate?.().catch(() => null);
    if (est?.quota !== undefined && est.usage !== undefined) {
      const free = est.quota - est.usage;
      if (size + STORAGE_MARGIN > free) {
        const gb = (n: number) => `${(n / 1e9).toFixed(n < 1e10 ? 1 : 0)} gb`;
        throw new EngineError(`not enough browser storage: this needs ${gb(size)}, and your browser allows about ${gb(Math.max(0, free))} more. free some space or pick fewer files.`);
      }
    }
    void navigator.storage?.persist?.().catch(() => false);
    this.applySelection(item, files);
    item.rec.sequential = opts.sequential;
    item.rec.error = null;
    if (item.dl) {
      try {
        await this.prepare(item);
      } catch (err) {
        item.rec.error = friendlyStorageError(err);
        item.dl.stop('storage failed');
        this.changed(true);
        throw new EngineError(item.rec.error);
      }
      item.dl.sequentialMode = opts.sequential;
      item.dl.select(item.wanted!);
    }
    this.changed(true);
    this.schedule();
    return this.view(item);
  }

  async action(hash: string, action: 'pause' | 'resume' | 'recheck' | 'stop-seeding'): Promise<TorrentView> {
    const item = this.need(hash);
    if (action === 'pause') {
      item.rec.paused = true;
      item.starting = false;
      item.dl?.stop('paused');
    } else if (action === 'resume') {
      item.rec.paused = false;
      item.rec.error = null;
      this.schedule();
    } else if (action === 'recheck') {
      await this.recheck(item);
    }
    this.changed(true);
    return this.view(item);
  }

  /** Re-reads every chosen piece from storage and checks it against the torrent. */
  private async recheck(item: Item): Promise<void> {
    if (!item.info || !item.rec.selected || item.checking !== null) return;
    const d = item.dl;
    item.dl = null;
    item.starting = false;
    d?.stop('recheck');
    item.checking = 0;
    this.changed(false);
    const info = item.info;
    const have = new Uint8Array(info.pieceCount);
    const chosen = new Set(item.rec.selected);
    try {
      await this.prepare(item);
      const wanted = item.wanted!;
      let checked = 0;
      const total = wanted.reduce((n, v) => n + v, 0);
      for (let p = 0; p < info.pieceCount; p++) {
        if (!wanted[p]) continue;
        const segments = pieceSegments(info, p);
        let bytes: Uint8Array | null;
        if (segments.some((s) => !chosen.has(s.file))) {
          bytes = await storage.readPart(item.rec.hash, p);
        } else {
          bytes = new Uint8Array(info.pieceSize(p));
          for (const s of segments) {
            const chunk = await storage.read(item.rec.hash, s.file, s.fileOffset, s.length);
            if (!chunk) {
              bytes = null;
              break;
            }
            bytes.set(chunk, s.pieceOffset);
          }
        }
        if (bytes && bytes.length === info.pieceSize(p) && equalBytes(await sha1(bytes), info.pieceHash(p))) have[p] = 1;
        checked++;
        item.checking = checked / total;
        if (checked % 16 === 0) this.emitSoon();
      }
    } catch (err) {
      item.rec.error = friendlyStorageError(err);
    } finally {
      await storage.close(item.rec.hash).catch(() => {});
    }
    item.have = have;
    this.countDone(item);
    const size = this.selectedSize(item) ?? 0;
    item.rec.completedAt = item.doneBytes >= size ? (item.rec.completedAt ?? Date.now()) : null;
    item.checking = null;
    this.changed(true);
    this.schedule();
  }

  async remove(hash: string): Promise<void> {
    const item = this.need(hash);
    this.items.delete(hash);
    const d = item.dl;
    item.dl = null;
    item.starting = false;
    d?.stop('removed');
    for (const url of item.links) URL.revokeObjectURL(url);
    this.changed(true);
    await storage.remove(hash).catch(() => {});
    this.schedule();
  }

  async removeAll(): Promise<number> {
    const hashes = [...this.items.keys()];
    for (const h of hashes) await this.remove(h);
    return hashes.length;
  }

  /** Links to save the finished files: disk-backed, so even big files don't fill the memory. */
  async links(hash: string): Promise<Links> {
    const item = this.need(hash);
    if (!item.info || !item.rec.selected || !item.have) return { expiresAt: Date.now(), files: [], zip: null };
    for (const url of item.links) URL.revokeObjectURL(url);
    item.links = [];
    // flushes and releases the files; a running download reopens them on its next write
    await storage.close(hash);
    const per = fileProgress(item.info, item.have);
    const files: Links['files'] = [];
    for (const i of item.rec.selected) {
      const f = item.info.files[i];
      if (per[i] < f.length) continue;
      const file = await finishedFile(hash, item.paths![i]);
      const url = URL.createObjectURL(file);
      item.links.push(url);
      files.push({ index: i, path: item.info.files.length === 1 ? item.info.name : f.path, size: f.length, url });
    }
    return { expiresAt: Date.now() + 3600_000, files, zip: null };
  }

  // ── views and saving ──────────────────────────────────────────────────

  private need(hash: string): Item {
    const item = this.items.get(hash);
    if (!item) throw new EngineError('that torrent is no longer in your list.');
    return item;
  }

  view(item: Item): TorrentView {
    const { rec, info } = item;
    const size = this.selectedSize(item);
    const progress = item.checking !== null ? item.checking : size ? Math.min(1, item.doneBytes / size) : rec.completedAt ? 1 : 0;
    let state: TorrentView['state'];
    if (item.checking !== null) state = 'checking';
    else if (rec.error) state = 'error';
    else if (!info) state = rec.paused ? 'paused' : 'metadata';
    else if (!rec.selected) state = 'selecting';
    else if (rec.completedAt) state = 'done';
    else if (rec.paused) state = 'paused';
    else if (!item.dl) state = 'queued';
    else if (item.peers === 0 && Date.now() - item.dlStartedAt > 30_000) state = 'stalled';
    else state = 'downloading';
    const left = size !== null ? size - item.doneBytes : null;
    return {
      hash: rec.hash,
      name: rec.name,
      state,
      progress,
      totalSize: info ? info.length : null,
      selectedSize: size,
      downloaded: item.doneBytes,
      dlSpeed: state === 'downloading' ? item.speed : 0,
      upSpeed: 0,
      uploaded: 0,
      eta: state === 'downloading' && item.speed > 0 && left !== null ? left / item.speed : null,
      peers: item.peers,
      seeds: item.seeds,
      ratio: 0,
      fileCount: info ? info.files.length : null,
      paused: rec.paused,
      seed: false,
      ratioLimit: 0,
      sequential: rec.sequential,
      addedAt: rec.addedAt,
      completedAt: rec.completedAt,
      seedEndsAt: null,
      error: rec.error,
    };
  }

  private emit(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    const views = [...this.items.values()].sort((a, b) => b.rec.addedAt - a.rec.addedAt).map((i) => this.view(i));
    this.onchange(views);
  }

  private emitSoon(): void {
    this.emitTimer ??= setTimeout(() => this.emit(), 500);
  }

  /** Something changed: update the views now or soon, and save soon (or now, for important changes). */
  private changed(important: boolean): void {
    if (important) this.emit();
    else this.emitSoon();
    if (important) this.save();
    else this.saveTimer ??= setTimeout(() => this.save(), 3000);
  }

  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const recs = [...this.items.values()].map((i) => ({ ...i.rec, have: i.have && i.info ? pack(i.have) : null }));
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify(recs));
    } catch {
      // storage blocked or full: the list just won't survive a reload
    }
  }
}
