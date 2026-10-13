import { createHash } from 'node:crypto';
import { encode, type BDict } from '../src/bencode.js';

export interface TestFile {
  path: string[];
  data: Buffer;
}

/** Builds a real v1 .torrent for the given files (multi-file layout under `name`). */
export function makeTorrent(name: string, files: TestFile[], pieceLength = 16384, extra: BDict = {}): { torrent: Buffer; infoHash: string } {
  const all = Buffer.concat(files.map((f) => f.data));
  const pieces: Buffer[] = [];
  for (let i = 0; i < all.length; i += pieceLength) pieces.push(createHash('sha1').update(all.subarray(i, i + pieceLength)).digest());
  const info: BDict = {
    name: Buffer.from(name),
    'piece length': pieceLength,
    pieces: Buffer.concat(pieces.length ? pieces : [createHash('sha1').update(Buffer.alloc(0)).digest()]),
    files: files.map((f) => ({ length: f.data.length, path: f.path.map((p) => Buffer.from(p)) })),
  };
  const infoBuf = encode(info);
  const torrent = encode({ announce: Buffer.from('udp://tracker.invalid:6969/announce'), info, ...extra });
  return { torrent, infoHash: createHash('sha1').update(infoBuf).digest('hex') };
}

/** Deterministic pseudo-random bytes so tests are reproducible. */
export function bytes(n: number, seed: number): Buffer {
  const b = Buffer.alloc(n);
  let x = seed || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x & 0xff;
  }
  return b;
}
