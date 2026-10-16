/** Magnet links, .torrent files and the info dict. */
import { decode, text } from './bencode.js';

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha1(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function base32ToHex(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.toUpperCase()) {
    const v = alphabet.indexOf(c);
    if (v === -1) throw new Error('bad base32 info hash');
    bits += v.toString(2).padStart(5, '0');
  }
  let out = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) out += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return out;
}

/** { infoHash (hex), name, trackers } from a magnet link (BitTorrent v1 only). */
export function parseMagnet(uri) {
  if (!uri.startsWith('magnet:?')) throw new Error('not a magnet link');
  const params = new URLSearchParams(uri.slice(8));
  let infoHash = null;
  for (const xt of params.getAll('xt')) {
    const m = /^urn:btih:([0-9a-fA-F]{40}|[A-Za-z2-7]{32})$/.exec(xt);
    if (m) infoHash = m[1].length === 40 ? m[1].toLowerCase() : base32ToHex(m[1]);
  }
  if (!infoHash) throw new Error('the magnet has no BitTorrent v1 info hash');
  return { infoHash, name: params.get('dn') ?? null, trackers: params.getAll('tr'), peers: params.getAll('x.pe') };
}

/** Parses a .torrent file. */
export async function parseTorrentFile(bytes) {
  const { value, ranges } = decode(bytes);
  if (!value.info || !ranges.info) throw new Error('the .torrent has no info dict');
  const infoBytes = bytes.subarray(ranges.info[0], ranges.info[1]);
  const infoHash = hex(await sha1(infoBytes));
  const trackers = [];
  if (value.announce) trackers.push(text(value.announce));
  for (const tier of value['announce-list'] ?? []) for (const t of tier) trackers.push(text(t));
  return { infoHash, trackers: [...new Set(trackers.filter(Boolean))], peers: [], info: parseInfo(infoBytes) };
}

/** Turns raw info dict bytes into what the downloader needs. */
export function parseInfo(infoBytes) {
  const { value: info } = decode(infoBytes);
  const pieceLength = info['piece length'];
  const pieces = info.pieces;
  if (!Number.isInteger(pieceLength) || pieceLength <= 0 || !(pieces instanceof Uint8Array) || pieces.length % 20)
    throw new Error('the info dict is malformed');
  const name = text(info['name.utf-8'] ?? info.name) ?? 'download';
  let files;
  if (Array.isArray(info.files)) {
    files = info.files.map((f) => ({ path: (f['path.utf-8'] ?? f.path).map(text).join('/'), length: f.length }));
  } else {
    files = [{ path: name, length: info.length }];
  }
  let offset = 0;
  for (const f of files) {
    if (!Number.isSafeInteger(f.length) || f.length < 0) throw new Error('the info dict is malformed');
    f.offset = offset;
    offset += f.length;
  }
  const length = offset;
  const count = pieces.length / 20;
  if (!Number.isSafeInteger(length) || Math.ceil(length / pieceLength) !== count) throw new Error('the info dict sizes don\'t add up');
  return {
    raw: infoBytes,
    name,
    files,
    length,
    pieceLength,
    pieceCount: count,
    pieceHash: (i) => pieces.subarray(i * 20, i * 20 + 20),
    pieceSize: (i) => (i === count - 1 ? length - pieceLength * (count - 1) : pieceLength),
  };
}
