/**
 * Validation for what users submit: magnet links and .torrent files.
 * Both produce an info hash (the torrent's id in qBittorrent) before anything
 * reaches the engine, so ownership can be checked and abuse blocked up front.
 */
import { createHash } from 'node:crypto';
import { BencodeError, decode, type BDict, type BValue } from './bencode.js';

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

export interface MagnetInfo {
  infoHash: string;
  name: string | null;
  trackers: string[];
  /** A rebuilt magnet with only xt, dn and tr, so no web seeds or other extras reach the engine. */
  magnet: string;
}

export interface TorrentFileInfo {
  infoHash: string;
  name: string;
  totalSize: number;
  fileCount: number;
}

const MAX_MAGNET_LENGTH = 8192;
const MAX_TRACKERS = 50;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(s: string): string {
  let bits = '';
  for (const ch of s.toUpperCase()) {
    const v = BASE32.indexOf(ch);
    if (v === -1) throw new InputError('that magnet link has an invalid info hash');
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

const isTrackerUrl = (u: string) => {
  try {
    const url = new URL(u);
    return ['http:', 'https:', 'udp:'].includes(url.protocol) && !!url.hostname && u.length <= 2048;
  } catch {
    return false;
  }
};

/** Strips control characters and trims a display name; never used as a path. */
export function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
}

export function parseMagnet(input: string): MagnetInfo {
  const raw = input.trim();
  if (raw.length > MAX_MAGNET_LENGTH) throw new InputError('that magnet link is too long');
  if (!/^magnet:\?/i.test(raw)) throw new InputError("that's not a magnet link");
  const params = new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
  let infoHash: string | null = null;
  let hasV2 = false;
  for (const xt of params.getAll('xt')) {
    const m = /^urn:btih:([0-9a-f]{40}|[a-z2-7]{32})$/i.exec(xt);
    if (m) infoHash = m[1]!.length === 40 ? m[1]!.toLowerCase() : base32ToHex(m[1]!);
    else if (/^urn:btmh:/i.test(xt)) hasV2 = true;
  }
  if (!infoHash) {
    throw new InputError(hasV2 ? "v2-only magnet links aren't supported yet" : 'that magnet link has no valid info hash');
  }
  const dn = params.get('dn');
  const name = dn ? cleanName(dn) || null : null;
  const trackers = [...new Set(params.getAll('tr').filter(isTrackerUrl))].slice(0, MAX_TRACKERS);
  const parts = [`xt=urn:btih:${infoHash}`];
  if (name) parts.push(`dn=${encodeURIComponent(name)}`);
  for (const tr of trackers) parts.push(`tr=${encodeURIComponent(tr)}`);
  return { infoHash, name, trackers, magnet: `magnet:?${parts.join('&')}` };
}

const asDict = (v: BValue | undefined): BDict | null =>
  v && typeof v === 'object' && !Buffer.isBuffer(v) && !Array.isArray(v) ? v : null;
const asInt = (v: BValue | undefined): number | null => (typeof v === 'number' ? v : null);
const asBuf = (v: BValue | undefined): Buffer | null => (Buffer.isBuffer(v) ? v : null);

function checkPathPart(part: Buffer | null): string {
  if (!part) throw new InputError('that .torrent file has a broken file list');
  const s = part.toString('utf8');
  if (!s || s === '.' || s === '..' || /[/\\\u0000]/.test(s)) throw new InputError('that .torrent file has an unsafe file path');
  return s;
}

/** Validates a .torrent file and computes its v1 info hash. */
export function parseTorrentFile(buf: Buffer, maxBytes: number): TorrentFileInfo {
  if (buf.length === 0) throw new InputError('that .torrent file is empty');
  if (buf.length > maxBytes) throw new InputError(`.torrent files can be at most ${Math.floor(maxBytes / 1024)} KB`);
  const span = { start: -1, end: -1 };
  let root: BDict | null;
  try {
    root = asDict(decode(buf, span));
  } catch (err) {
    if (err instanceof BencodeError) throw new InputError("that file isn't a valid .torrent");
    throw err;
  }
  const info = asDict(root?.info);
  if (!root || !info || span.start < 0) throw new InputError("that file isn't a valid .torrent");

  const pieces = asBuf(info.pieces);
  if (!pieces) {
    if (asInt(info['meta version']) === 2) throw new InputError("v2-only torrents aren't supported yet");
    throw new InputError("that file isn't a valid .torrent");
  }
  const pieceLength = asInt(info['piece length']);
  if (!pieceLength || pieceLength <= 0 || pieces.length === 0 || pieces.length % 20 !== 0) {
    throw new InputError("that file isn't a valid .torrent");
  }

  const nameBuf = asBuf(info['name.utf-8']) ?? asBuf(info.name);
  const name = nameBuf ? cleanName(nameBuf.toString('utf8')) : '';
  if (!name) throw new InputError('that .torrent file has no name');
  checkPathPart(nameBuf);

  let totalSize = 0;
  let fileCount = 0;
  const single = asInt(info.length);
  if (single !== null) {
    if (single < 0) throw new InputError("that file isn't a valid .torrent");
    totalSize = single;
    fileCount = 1;
  } else {
    const files = info.files;
    if (!Array.isArray(files) || files.length === 0) throw new InputError('that .torrent file has no files');
    for (const f of files) {
      const fd = asDict(f);
      const len = asInt(fd?.length);
      const path = fd?.['path.utf-8'] ?? fd?.path;
      if (!fd || len === null || len < 0 || !Array.isArray(path) || path.length === 0) {
        throw new InputError('that .torrent file has a broken file list');
      }
      path.forEach((p) => checkPathPart(asBuf(p)));
      const attr = asBuf(fd.attr)?.toString('latin1') ?? '';
      if (attr.includes('p')) continue; // BEP 47 padding file, never shown or downloaded on its own
      totalSize += len;
      fileCount++;
    }
  }
  if (!Number.isSafeInteger(totalSize)) throw new InputError("that file isn't a valid .torrent");
  // pieces must cover the whole payload (padding included), or the file is corrupt
  if (Math.ceil(totalSize / pieceLength) > pieces.length / 20) throw new InputError("that file isn't a valid .torrent");

  const infoHash = createHash('sha1').update(buf.subarray(span.start, span.end)).digest('hex');
  return { infoHash, name, totalSize, fileCount };
}

export const isInfoHash = (s: string) => /^[0-9a-f]{40}$/.test(s);
