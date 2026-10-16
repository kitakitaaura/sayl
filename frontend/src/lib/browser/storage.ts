/** The main thread's side of the storage worker, plus reading finished files for saving. */
import type { PrepareFile, Request, Segment } from './storage.worker';

export class StorageError extends Error {
  constructor(
    readonly name: string,
    message: string,
  ) {
    super(message);
  }
}

let worker: Worker | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function call<T>(req: Request, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./storage.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; name?: string; message?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.ok) w.resolve(e.data.result);
      else w.reject(new StorageError(e.data.name ?? 'Error', e.data.message ?? 'storage failed'));
    };
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, req }, transfer);
  });
}

export const storage = {
  prepare: (hash: string, files: PrepareFile[]) => call<null>({ op: 'prepare', hash, files }),
  /** `bytes` is copied to the worker, so the caller can keep using it. */
  write: (hash: string, piece: number, bytes: Uint8Array, segments: Segment[], part: boolean) =>
    call<null>({ op: 'write', hash, piece, bytes, segments, part }),
  read: (hash: string, index: number, offset: number, length: number) => call<Uint8Array | null>({ op: 'read', hash, index, offset, length }),
  readPart: (hash: string, piece: number) => call<Uint8Array | null>({ op: 'readPart', hash, piece }),
  close: (hash: string) => call<null>({ op: 'close', hash }),
  remove: (hash: string) => call<null>({ op: 'remove', hash }),
  saveInfo: (hash: string, bytes: Uint8Array) => call<null>({ op: 'saveInfo', hash, bytes }),
  loadInfo: (hash: string) => call<Uint8Array | null>({ op: 'loadInfo', hash }),
};

/** A finished file, as a disk-backed File the browser can save without loading it into memory. */
export async function finishedFile(hash: string, parts: string[]): Promise<File> {
  let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sayl');
  dir = await dir.getDirectoryHandle(hash);
  dir = await dir.getDirectoryHandle('files');
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}

/** True when this browser can store downloads (OPFS with sync access handles). */
export function storageSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory && typeof Worker !== 'undefined';
}
