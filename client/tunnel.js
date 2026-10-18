/** A TCP connection made by the relay, carried over one WebSocket. */
import { countDoMessages, countRequest } from './usage.js';

/**
 * relay: { url: 'https://…' or 'http://…', via: 'worker' | 'do', session, token }
 * Resolves once the relay has opened the TCP connection.
 */
export function openTunnel(relay, { host, port, tls = false }, timeoutMs = 10_000) {
  const u = new URL('/tunnel', relay.url);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('host', host);
  u.searchParams.set('port', String(port));
  if (tls) u.searchParams.set('tls', '1');
  if (relay.via === 'do') {
    u.searchParams.set('via', 'do');
    u.searchParams.set('session', relay.session);
  }
  if (relay.token) u.searchParams.set('token', relay.token);
  const durableObject = relay.via === 'do';
  countRequest({ durableObject });

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u);
    ws.binaryType = 'arraybuffer';
    const tunnel = new Tunnel(ws, durableObject);
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('timed out connecting'), timeoutMs);
    ws.addEventListener('message', (e) => {
      if (typeof e.data === 'string') {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === 'open' && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(tunnel);
        } else if (msg.t === 'error') {
          tunnel.error = msg.m;
          fail(msg.m);
        }
        return;
      }
      tunnel.bytesIn += e.data.byteLength;
      tunnel.ondata?.(new Uint8Array(e.data));
    });
    ws.addEventListener('close', (e) => {
      fail(tunnel.error ?? `relay closed the connection (${e.code}${e.reason ? ` ${e.reason}` : ''})`);
      tunnel.closed = true;
      tunnel.onclose?.(tunnel.error ?? e.reason);
    });
    ws.addEventListener('error', () => fail('relay unreachable'));
  });
}

/** The largest WebSocket message a tunnel sends (well under Cloudflare's limits). */
const MAX_MESSAGE = 256 * 1024;

/**
 * Small writes made in the same tick (block requests, haves) go out as one
 * WebSocket message. Durable Objects bill incoming messages, so this keeps
 * a download to a handful of messages per MB instead of one per block.
 */
class Tunnel {
  constructor(ws, durableObject = false) {
    this.ws = ws;
    this.durableObject = durableObject;
    this.queue = [];
    this.ondata = null;
    this.onclose = null;
    this.closed = false;
    this.error = null;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.messagesOut = 0;
  }
  send(bytes) {
    if (this.closed || this.ws.readyState !== 1) return;
    this.bytesOut += bytes.length;
    if (this.queue.push(bytes) === 1) queueMicrotask(() => this.#flush());
  }
  #flush() {
    const parts = this.queue.splice(0);
    if (this.closed || this.ws.readyState !== 1 || !parts.length) return;
    // Join small writes, but keep each WebSocket message under MAX_MESSAGE (uploads send whole blocks).
    let batch = [];
    let size = 0;
    const sendBatch = () => {
      if (!batch.length) return;
      this.messagesOut++;
      if (this.durableObject) countDoMessages(1);
      if (batch.length === 1) this.ws.send(batch[0]);
      else {
        const out = new Uint8Array(size);
        let o = 0;
        for (const p of batch) {
          out.set(p, o);
          o += p.length;
        }
        this.ws.send(out);
      }
      batch = [];
      size = 0;
    };
    for (let p of parts) {
      while (p.length) {
        const room = MAX_MESSAGE - size;
        const take = p.length <= room ? p : p.subarray(0, room);
        batch.push(take);
        size += take.length;
        p = p.subarray(take.length);
        if (size >= MAX_MESSAGE) sendBatch();
      }
    }
    sendBatch();
  }
  /** Bytes waiting to go out: queued here or buffered by the WebSocket. */
  get buffered() {
    return this.queue.reduce((n, p) => n + p.length, 0) + (this.ws.bufferedAmount ?? 0);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {}
  }
}
