/**
 * What the relay agrees to carry. Pure functions, so they can be tested in Node.
 *
 * The relay is a TCP pipe for exactly two things:
 *   1. BitTorrent peer connections: the browser must open with a BitTorrent
 *      handshake and the remote must answer with one, before anything else
 *      is passed along.
 *   2. One HTTP(S) tracker announce: a single GET whose path contains
 *      "announce" and whose query has info_hash, and nothing after it.
 * Anything else closes the tunnel, so it can't be used as an open proxy.
 */

export const BT_PREFIX = new Uint8Array([19, ...new TextEncoder().encode('BitTorrent protocol')]);
export const BT_HANDSHAKE_LENGTH = 68;
export const MAX_ANNOUNCE_RESPONSE = 1024 * 1024;

const BLOCKED_PORTS = new Set([25, 465, 587]);

export function startsWithBtHandshake(bytes) {
  if (bytes.length < BT_PREFIX.length) return false;
  for (let i = 0; i < BT_PREFIX.length; i++) if (bytes[i] !== BT_PREFIX[i]) return false;
  return true;
}

const ANNOUNCE_LINE = /^GET (\/[!-~]*announce[!-~]*\?[!-~]*\binfo_hash=[!-~]+) HTTP\/1\.[01]\r\n/;

/** True when the bytes are exactly one tracker announce request with no body. */
export function isAnnounceRequest(bytes) {
  if (bytes.length > 8192) return false;
  const text = latin1(bytes);
  if (!ANNOUNCE_LINE.test(text)) return false;
  const end = text.indexOf('\r\n\r\n');
  return end !== -1 && end + 4 === text.length;
}

export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/** Parses and checks the tunnel target. Returns { host, port, tls } or { error }. */
export function parseTarget(params, { allowPrivate = false } = {}) {
  const host = (params.get('host') ?? '').trim().toLowerCase();
  const port = Number(params.get('port'));
  const tls = params.get('tls') === '1';
  if (!host || host.length > 253) return { error: 'missing host' };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'bad port' };
  if (BLOCKED_PORTS.has(port)) return { error: 'port not allowed' };
  const ip = host.replace(/^\[|\]$/g, '');
  const kind = ipKind(ip);
  if (kind === 'invalid') return { error: 'bad host' };
  if (kind === 'name' && !/^[a-z0-9.-]+$/.test(ip)) return { error: 'bad host' };
  if (!allowPrivate) {
    const localName = ip === 'localhost' || /\.(localhost|local|internal)$/.test(ip);
    if (kind === 'name' ? localName : !isPublicIp(ip, kind)) return { error: 'private address' };
  }
  return { host: ip, port, tls };
}

export function ipKind(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host.split('.').every((p) => Number(p) <= 255) ? 'v4' : 'invalid';
  if (host.includes(':')) return /^[0-9a-f:.]+$/.test(host) ? 'v6' : 'invalid';
  return 'name';
}

function isPublicIp(ip, kind) {
  if (kind === 'v4') {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return false;
  if (v.startsWith('::ffff:')) {
    const tail = v.slice(7);
    return ipKind(tail) === 'v4' ? isPublicIp(tail, 'v4') : false;
  }
  const first = parseInt(v.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  return true;
}
