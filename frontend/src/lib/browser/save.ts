/** Saving a whole torrent at once: into a folder the visitor picks (Chrome, Edge), or as one .zip. */
import { makeZip } from '$bt';

export interface SaveFile {
  /** "/"-separated, inside the torrent (a multi-file torrent's files start with its folder) */
  path: string;
  file: File;
}

type DirectoryPicker = (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;

/** Whether this browser can write into a folder the visitor picks. */
export const canSaveToFolder = () => typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

/**
 * Asks for a folder, then copies every file into it, keeping the torrent's folders. Returns false when the
 * visitor closed the picker. Files stream from disk to disk; `onprogress` gets 0..1.
 */
export async function saveToFolder(files: SaveFile[], onprogress: (fraction: number) => void, signal?: AbortSignal): Promise<boolean> {
  let root: FileSystemDirectoryHandle;
  try {
    root = await (window as unknown as { showDirectoryPicker: DirectoryPicker }).showDirectoryPicker({ id: 'sayl', mode: 'readwrite' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return false;
    throw err;
  }
  const total = files.reduce((n, f) => n + f.file.size, 0) || 1;
  let done = 0;
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
    const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await handle.createWritable();
    const count = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        done += chunk.byteLength;
        onprogress(done / total);
        controller.enqueue(chunk);
      },
    });
    await f.file.stream().pipeThrough(count).pipeTo(writable, { signal });
  }
  onprogress(1);
  return true;
}

/** Builds the .zip (reading each file once, for its checksum) and saves it. `onprogress` gets 0..1. */
export async function saveAsZip(name: string, files: SaveFile[], onprogress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  const zip = await makeZip(
    files.map((f) => ({ path: f.path, blob: f.file })),
    { onprogress: (read, total) => onprogress(total ? read / total : 1), signal },
  );
  const url = URL.createObjectURL(zip);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.zip`;
  a.click();
  // the browser holds on to the file once the download starts
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
}
