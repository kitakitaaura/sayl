/**
 * Writes and reads torrent data in the origin private file system (OPFS), off
 * the main thread. Sync access handles are the fast, random-access way in, and
 * they only exist in workers.
 *
 * Layout: sayl/<hash>/info.bin        the torrent's info dict
 *         sayl/<hash>/files/<path>    the files the user picked
 *         sayl/<hash>/parts/<piece>   whole pieces that also cover files the user didn't pick
 */

interface SyncHandle {
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}
type FileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> };

export interface PrepareFile {
  index: number;
  parts: string[];
  length: number;
}

export interface Segment {
  index: number;
  fileOffset: number;
  pieceOffset: number;
  length: number;
}

export type Request =
  | { op: 'prepare'; hash: string; files: PrepareFile[] }
  /** One verified piece: its bytes go to the given file ranges, and whole to parts/ when `part` is set. */
  | { op: 'write'; hash: string; piece: number; bytes: Uint8Array; segments: Segment[]; part: boolean }
  | { op: 'read'; hash: string; index: number; offset: number; length: number }
  | { op: 'readPart'; hash: string; piece: number }
  | { op: 'close'; hash: string }
  | { op: 'remove'; hash: string }
  | { op: 'saveInfo'; hash: string; bytes: Uint8Array }
  | { op: 'loadInfo'; hash: string };

const open = new Map<string, Map<number, SyncHandle>>(); // hash → file index → handle

async function root(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle('sayl', { create: true });
}

async function torrentDir(hash: string, create = true): Promise<FileSystemDirectoryHandle> {
  return (await root()).getDirectoryHandle(hash, { create });
}

async function dirFor(hash: string, path: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let dir = await torrentDir(hash, create);
  for (const p of path) dir = await dir.getDirectoryHandle(p, { create });
  return dir;
}

async function handleFor(hash: string, file: PrepareFile): Promise<SyncHandle> {
  let byIndex = open.get(hash);
  if (!byIndex) open.set(hash, (byIndex = new Map()));
  const existing = byIndex.get(file.index);
  if (existing) return existing;
  const dir = await dirFor(hash, ['files', ...file.parts.slice(0, -1)], true);
  const fh = (await dir.getFileHandle(file.parts[file.parts.length - 1], { create: true })) as FileHandle;
  const h = await fh.createSyncAccessHandle();
  byIndex.set(file.index, h);
  return h;
}

/** What each torrent's files are called, so handles can be reopened after a close. */
const layout = new Map<string, Map<number, PrepareFile>>();

async function reopen(hash: string, index: number): Promise<SyncHandle> {
  const f = layout.get(hash)?.get(index);
  if (!f) throw new Error(`file ${index} of ${hash} was never prepared`);
  return handleFor(hash, f);
}

function closeAll(hash: string): void {
  for (const h of open.get(hash)?.values() ?? []) {
    try {
      h.flush();
      h.close();
    } catch {
      // already closed
    }
  }
  open.delete(hash);
}

async function handle(req: Request): Promise<unknown> {
  switch (req.op) {
    case 'prepare': {
      layout.set(req.hash, new Map(req.files.map((f) => [f.index, f])));
      for (const f of req.files) {
        const h = await handleFor(req.hash, f);
        // Reserving the full size up front makes a full disk fail now, not halfway through.
        if (h.getSize() !== f.length) h.truncate(f.length);
      }
      return null;
    }
    case 'write': {
      for (const s of req.segments) {
        const h = await reopen(req.hash, s.index);
        h.write(req.bytes.subarray(s.pieceOffset, s.pieceOffset + s.length), { at: s.fileOffset });
      }
      if (req.part) {
        const dir = await dirFor(req.hash, ['parts'], true);
        const fh = (await dir.getFileHandle(String(req.piece), { create: true })) as FileHandle;
        const h = await fh.createSyncAccessHandle();
        try {
          h.truncate(0);
          h.write(req.bytes, { at: 0 });
          h.flush();
        } finally {
          h.close();
        }
      }
      return null;
    }
    case 'read': {
      const h = await reopen(req.hash, req.index);
      const buf = new Uint8Array(req.length);
      const n = h.read(buf, { at: req.offset });
      return n === req.length ? buf : null;
    }
    case 'readPart': {
      try {
        const dir = await dirFor(req.hash, ['parts'], false);
        const fh = (await dir.getFileHandle(String(req.piece))) as FileHandle;
        return new Uint8Array(await (await fh.getFile()).arrayBuffer());
      } catch {
        return null;
      }
    }
    case 'close':
      closeAll(req.hash);
      return null;
    case 'remove': {
      closeAll(req.hash);
      layout.delete(req.hash);
      try {
        await (await root()).removeEntry(req.hash, { recursive: true });
      } catch {
        // already gone
      }
      return null;
    }
    case 'saveInfo': {
      const fh = (await (await torrentDir(req.hash)).getFileHandle('info.bin', { create: true })) as FileHandle;
      const h = await fh.createSyncAccessHandle();
      try {
        h.truncate(0);
        h.write(req.bytes, { at: 0 });
        h.flush();
      } finally {
        h.close();
      }
      return null;
    }
    case 'loadInfo': {
      try {
        const fh = await (await torrentDir(req.hash, false)).getFileHandle('info.bin');
        return new Uint8Array(await (await fh.getFile()).arrayBuffer());
      } catch {
        return null;
      }
    }
  }
}

// Requests run one at a time, in order, so writes never interleave with closes.
let queue: Promise<unknown> = Promise.resolve();
self.onmessage = (e: MessageEvent<{ id: number; req: Request }>) => {
  const { id, req } = e.data;
  queue = queue.then(async () => {
    try {
      const result = await handle(req);
      const transfer = result instanceof Uint8Array ? [result.buffer] : [];
      (self as unknown as Worker).postMessage({ id, ok: true, result }, transfer as Transferable[]);
    } catch (err) {
      const e = err as Error;
      (self as unknown as Worker).postMessage({ id, ok: false, name: e?.name ?? 'Error', message: e?.message ?? String(err) });
    }
  });
};
