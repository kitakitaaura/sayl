/**
 * A TURN client (RFC 8656) over a TCP connection, which is what the relay
 * gives us. It gets UDP into the browser: an allocation on the TURN server
 * sends and receives UDP datagrams on our behalf. Used for the DHT.
 *
 *   const turn = await TurnClient.connect(stream, { username, password });
 *   await turn.permit(['1.2.3.4']);
 *   turn.onmessage = (host, port, bytes) => …;
 *   turn.send('1.2.3.4', 6881, bytes);
 *
 * `stream` is anything with send(bytes), ondata and onclose (a relay tunnel,
 * or a plain socket in Node).
 */
import { md5 } from './md5.js';

const MAGIC = 0x2112a442;
const T = { allocate: 0x0003, refresh: 0x0004, send: 0x0016, data: 0x0017, createPermission: 0x0008 };
const A = {
  username: 0x0006,
  integrity: 0x0008,
  error: 0x0009,
  peer: 0x0012,
  data: 0x0013,
  realm: 0x0014,
  nonce: 0x0015,
  relayed: 0x0016,
  transport: 0x0019,
  mapped: 0x0020,
  lifetime: 0x000d,
};
const enc = new TextEncoder();
const dec = new TextDecoder();

export class TurnError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** "turns:host:443?transport=tcp" → { host, port, tls }, or null for UDP-only addresses. */
export function parseTurnUrl(url) {
  const m = /^(turns?):(\[[^\]]+\]|[^:?]+)(?::(\d+))?(?:\?(.*))?$/.exec(url);
  if (!m) return null;
  const tls = m[1] === 'turns';
  if (!tls && !/transport=tcp/.test(m[4] ?? '')) return null; // the relay only carries TCP
  return { host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3]) || (tls ? 5349 : 3478), tls };
}

/**
 * Asks the relay for short-lived TURN logins (it holds the operator's TURN
 * account). Returns [{ url, username, credential }], TLS on 443 first.
 */
export async function fetchTurnServers(relay) {
  const u = new URL('/turn-credentials', relay.url);
  if (relay.token) u.searchParams.set('token', relay.token);
  let res;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new TurnError(`couldn't get TURN logins: ${err.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new TurnError(body.error ?? `couldn't get TURN logins (${res.status})`, res.status === 503 ? 'off' : res.status);
  const rank = (s) => (/^turns:.*:443\b/.test(s.url) ? 0 : /^turns:/.test(s.url) ? 1 : 2);
  return (body.servers ?? []).filter((s) => parseTurnUrl(s.url)).sort((a, b) => rank(a) - rank(b));
}

/** Builds a STUN message. attrs: [[type, Uint8Array]] */
export function stunMessage(type, attrs, txid = crypto.getRandomValues(new Uint8Array(12))) {
  const body = [];
  for (const [t, v] of attrs) {
    const pad = (4 - (v.length % 4)) % 4;
    const a = new Uint8Array(4 + v.length + pad);
    const dv = new DataView(a.buffer);
    dv.setUint16(0, t);
    dv.setUint16(2, v.length);
    a.set(v, 4);
    body.push(a);
  }
  const len = body.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(20 + len);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, type);
  dv.setUint16(2, len);
  dv.setUint32(4, MAGIC);
  out.set(txid, 8);
  let o = 20;
  for (const a of body) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

/** Parses a STUN message: { type, txid, attrs: Map(type → Uint8Array) }. */
export function parseStun(msg) {
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  const type = dv.getUint16(0);
  const len = dv.getUint16(2);
  if (dv.getUint32(4) !== MAGIC || 20 + len > msg.length) throw new TurnError('not a STUN message');
  const attrs = new Map();
  let o = 20;
  while (o + 4 <= 20 + len) {
    const t = dv.getUint16(o);
    const l = dv.getUint16(o + 2);
    if (!attrs.has(t)) attrs.set(t, msg.subarray(o + 4, o + 4 + l));
    o += 4 + l + ((4 - (l % 4)) % 4);
  }
  return { type, txid: msg.subarray(8, 20), attrs };
}

/** XOR-MAPPED-ADDRESS style value → { host, port } (IPv4 and IPv6). */
export function decodeXorAddress(v, txid) {
  const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
  const family = v[1];
  const port = dv.getUint16(2) ^ (MAGIC >>> 16);
  if (family === 1) {
    const ip = dv.getUint32(4) ^ MAGIC;
    return { host: [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'), port };
  }
  const key = new Uint8Array(16);
  new DataView(key.buffer).setUint32(0, MAGIC);
  key.set(txid, 4);
  const groups = [];
  for (let i = 0; i < 8; i++) groups.push((((v[4 + i * 2] ^ key[i * 2]) << 8) | (v[5 + i * 2] ^ key[i * 2 + 1])).toString(16));
  return { host: groups.join(':'), port };
}

/** { host (IPv4), port } → XOR-PEER-ADDRESS value. */
export function encodeXorAddress(host, port) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) throw new TurnError(`only IPv4 peers are supported (${host})`);
  const v = new Uint8Array(8);
  const dv = new DataView(v.buffer);
  v[1] = 1;
  dv.setUint16(2, port ^ (MAGIC >>> 16));
  dv.setUint32(4, (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) ^ MAGIC) >>> 0);
  return v;
}

/** Appends MESSAGE-INTEGRITY (HMAC-SHA1 with the long-term key) to a STUN message. */
export async function withIntegrity(msg, key) {
  const out = new Uint8Array(msg.length + 24);
  out.set(msg);
  // The length field must already count the MESSAGE-INTEGRITY attribute when the HMAC is computed.
  new DataView(out.buffer).setUint16(2, msg.length - 20 + 24);
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, out.subarray(0, msg.length)));
  const dv = new DataView(out.buffer);
  dv.setUint16(msg.length, A.integrity);
  dv.setUint16(msg.length + 2, 20);
  out.set(mac, msg.length + 4);
  return out;
}

export class TurnClient {
  constructor(stream, { username, password }) {
    this.stream = stream;
    this.username = username;
    this.password = password;
    this.buf = new Uint8Array(0);
    this.pending = new Map(); // txid hex → { resolve, reject }
    this.onmessage = null;
    this.closed = false;
    this.realm = null;
    this.nonce = null;
    this.key = null;
    stream.ondata = (b) => this.#receive(b);
    stream.onclose = () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new TurnError('TURN connection closed'));
      this.pending.clear();
      clearInterval(this.refresher);
    };
  }

  /** Connects and allocates a UDP relay address. */
  static async connect(stream, creds) {
    const c = new TurnClient(stream, creds);
    const res = await c.#authed(T.allocate, [[A.transport, new Uint8Array([17, 0, 0, 0])]]);
    c.relayed = decodeXorAddress(res.attrs.get(A.relayed), res.txid);
    const mapped = res.attrs.get(A.mapped);
    c.mapped = mapped ? decodeXorAddress(mapped, res.txid) : null;
    const lifetime = res.attrs.get(A.lifetime);
    const secs = lifetime ? new DataView(lifetime.buffer, lifetime.byteOffset).getUint32(0) : 600;
    c.refresher = setInterval(() => c.#authed(T.refresh, [[A.lifetime, u32(600)]]).catch(() => {}), Math.max(60, secs - 60) * 1000);
    return c;
  }

  /** Lets these IPv4 addresses send to us (and us to them). Permissions last 5 minutes. */
  async permit(hosts) {
    const unique = [...new Set(hosts)];
    for (let i = 0; i < unique.length; i += 16) {
      await this.#authed(
        T.createPermission,
        unique.slice(i, i + 16).map((h) => [A.peer, encodeXorAddress(h, 0)]),
      );
    }
  }

  send(host, port, bytes) {
    if (this.closed) return;
    this.stream.send(stunMessage(T.send, [[A.peer, encodeXorAddress(host, port)], [A.data, bytes]]));
  }

  close() {
    clearInterval(this.refresher);
    this.stream.close?.();
  }

  async #authed(type, attrs) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let msg;
      if (this.nonce) {
        const auth = [[A.username, enc.encode(this.username)], [A.realm, enc.encode(this.realm)], [A.nonce, enc.encode(this.nonce)]];
        msg = await withIntegrity(stunMessage(type, [...attrs, ...auth]), this.key);
      } else {
        msg = stunMessage(type, attrs);
      }
      const res = await this.#request(msg);
      if ((res.type & 0x0110) === 0x0100) return res; // success response
      const err = res.attrs.get(A.error);
      const code = err ? err[2] * 100 + err[3] : 0;
      const reason = err ? dec.decode(err.subarray(4)) : 'unknown error';
      if ((code === 401 || code === 438) && res.attrs.has(A.nonce)) {
        if (code === 401 && this.nonce && attempt > 0) throw new TurnError('TURN refused the credentials', 401);
        this.realm = dec.decode(res.attrs.get(A.realm) ?? enc.encode(this.realm ?? ''));
        this.nonce = dec.decode(res.attrs.get(A.nonce));
        this.key = md5(enc.encode(`${this.username}:${this.realm}:${this.password}`));
        continue;
      }
      throw new TurnError(`TURN error ${code}: ${reason}`, code);
    }
    throw new TurnError('TURN authentication failed');
  }

  #request(msg) {
    const id = hexOf(msg.subarray(8, 20));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TurnError('TURN request timed out'));
      }, 10_000);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.stream.send(msg);
    });
  }

  #receive(bytes) {
    this.buf = this.buf.length ? concat(this.buf, bytes) : bytes;
    for (;;) {
      if (this.buf.length < 4) return;
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      const first = this.buf[0];
      let total;
      if (first >= 0x40 && first <= 0x4f) {
        total = 4 + dv.getUint16(2);
        total += (4 - (total % 4)) % 4; // ChannelData is padded over TCP
      } else {
        total = 20 + dv.getUint16(2);
      }
      if (this.buf.length < total) return;
      const msg = this.buf.subarray(0, total);
      this.buf = this.buf.slice(total);
      if (first >= 0x40 && first <= 0x4f) continue; // we never bind channels
      let m;
      try {
        m = parseStun(msg);
      } catch {
        continue;
      }
      if (m.type === T.data) {
        const peer = m.attrs.get(A.peer);
        const data = m.attrs.get(A.data);
        if (peer && data) {
          const { host, port } = decodeXorAddress(peer, m.txid);
          this.onmessage?.(host, port, data);
        }
        continue;
      }
      const p = this.pending.get(hexOf(m.txid));
      if (p) {
        this.pending.delete(hexOf(m.txid));
        p.resolve(m);
      }
    }
  }
}

const u32 = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const hexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
