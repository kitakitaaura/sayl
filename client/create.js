/**
 * Makes a BitTorrent v1 torrent from files, as Sayl's "share files" does.
 *
 *   const t = await createTorrent({ name, files: [{ path: ['photos', 'a.jpg'], blob }], trackers });
 *   t.infoHash   hex
 *   t.info       as parseInfo returns it (with .raw, the info dict's bytes)
 *   t.torrent    the .torrent file's bytes
 *   t.magnet     a magnet link with the name, size and up to 10 trackers
 *
 * One file makes a single-file torrent named after it; more make a folder
 * called `name`. Files are read in order, one piece at a time, so memory stays
 * at about one piece. onprogress(hashedBytes, totalBytes); signal aborts.
 */
import { concat, encode } from './bencode.js';
import { hex, parseInfo, sha1 } from './torrent.js';

const MIN_PIECE = 16 * 1024;
const MAX_PIECE = 16 * 1024 * 1024;
const TARGET_PIECES = 1500;

/** The smallest power-of-two piece size that keeps the torrent to about 1,500 pieces. */
export function pickPieceLength(total) {
  let size = MIN_PIECE;
  while (total / size > TARGET_PIECES && size < MAX_PIECE) size *= 2;
  return size;
}

export async function createTorrent({ name, files, trackers = [], pieceLength, onprogress, signal, createdBy = 'Sayl' }) {
  if (!Array.isArray(files) || !files.length) throw new Error('pick at least one file');
  const seen = new Set();
  for (const f of files) {
    if (!Array.isArray(f.path) || !f.path.length || f.path.some((p) => typeof p !== 'string' || !p || p === '.' || p === '..' || /[/\\]/.test(p))) {
      throw new Error(`a file has an unusable name: ${JSON.stringify(f.path)}`);
    }
    const key = f.path.join('/');
    if (seen.has(key)) throw new Error(`two files are both called ${key}`);
    seen.add(key);
  }
  const single = files.length === 1;
  const torrentName = single ? files[0].path[files[0].path.length - 1] : String(name ?? '').trim();
  if (!torrentName || /[/\\]/.test(torrentName) || torrentName === '.' || torrentName === '..') throw new Error('give the torrent a name');
  const total = files.reduce((n, f) => n + f.blob.size, 0);
  if (total === 0) throw new Error('the files are all empty');
  const size = pieceLength ?? pickPieceLength(total);
  const count = Math.ceil(total / size);
  const pieces = new Uint8Array(count * 20);

  let piece = new Uint8Array(Math.min(size, total));
  let filled = 0;
  let index = 0;
  let hashed = 0;
  const finishPiece = async () => {
    pieces.set(await sha1(piece.subarray(0, filled)), index * 20);
    hashed += filled;
    index++;
    filled = 0;
    if (index < count) piece = new Uint8Array(Math.min(size, total - index * size));
    onprogress?.(hashed, total);
  };
  for (const f of files) {
    let pos = 0;
    while (pos < f.blob.size) {
      if (signal?.aborted) throw signal.reason ?? new Error('cancelled');
      const take = Math.min(piece.length - filled, f.blob.size - pos);
      const chunk = new Uint8Array(await f.blob.slice(pos, pos + take).arrayBuffer());
      if (chunk.length !== take) throw new Error(`couldn't read ${f.path.join('/')}`);
      piece.set(chunk, filled);
      filled += take;
      pos += take;
      if (filled === piece.length) await finishPiece();
    }
  }
  if (filled) await finishPiece();
  if (index !== count) throw new Error('the files changed while they were being read');

  const info = single
    ? { name: torrentName, length: total, 'piece length': size, pieces }
    : { name: torrentName, files: files.map((f) => ({ length: f.blob.size, path: f.path })), 'piece length': size, pieces };
  const raw = encode(info);
  const infoHash = hex(await sha1(raw));
  return { infoHash, info: parseInfo(raw), torrent: torrentFile(raw, trackers, { createdBy }), magnet: magnetLink(infoHash, torrentName, total, trackers) };
}

/** A .torrent file around an info dict's exact bytes (so its info hash stays the same). */
export function torrentFile(infoRaw, trackers = [], { createdBy = 'Sayl', createdAt = Date.now() } = {}) {
  const list = [...new Set(trackers)];
  // keys in sorted order, as bencode requires; "info" last, written as the raw bytes
  const head = encode({
    announce: list[0],
    'announce-list': list.length ? list.map((t) => [t]) : undefined,
    'created by': createdBy,
    'creation date': Math.floor(createdAt / 1000),
  });
  return concat([head.subarray(0, head.length - 1), encode('info'), infoRaw, new Uint8Array([0x65])]);
}

/** A magnet link with the name, size and up to 10 trackers. */
export function magnetLink(infoHash, name, length, trackers = []) {
  const tr = [...new Set(trackers)].slice(0, 10).map((t) => `&tr=${encodeURIComponent(t)}`);
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${length ? `&xl=${length}` : ''}${tr.join('')}`;
}
