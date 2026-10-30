/**
 * HTTP(S) tracker announces, through the relay. Workers can't use UDP, so a
 * udp:// tracker is tried over HTTP on the same host and port (many big
 * trackers, opentrackr among them, answer both). The public trackers asked
 * for every torrent are in public-trackers.js.
 *
 * Two ways through the relay: its /announce (a fetch() from the Worker, which
 * reaches trackers behind Cloudflare and costs one request) and, for relays
 * without it or trackers it can't fetch, a tunnel carrying the raw request.
 * Trackers that fail both ways are remembered (deadTrackers) and skipped for
 * a while.
 */
import { decode, text } from './bencode.js';
import { openTunnel } from './tunnel.js';
import { countRequest } from './usage.js';

/** Trackers that failed both ways: announce URL → skip until (ms). Shared by every download; save it to keep it. */
export const deadTrackers = new Map();
export const DEAD_FOR_MS = 6 * 3600_000;

/** Relays without /announce (from before relay version 4): relay URL → true. */
const noFetch = new Map();
/** Trackers the relay couldn't fetch but a tunnel reached: announce URL → true. */
const tunnelOnly = new Map();

class TrackerError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 'tracker': it answered, but not usefully; 'unsupported': no /announce; else the way there failed
  }
}

/** Turns tracker URLs into unique HTTP(S) announce URLs. */
export function announceUrls(trackers) {
  const out = new Set();
  for (const t of trackers) {
    let u;
    try {
      u = new URL(t);
    } catch {
      continue;
    }
    if (u.protocol === 'udp:') {
      if (!u.port) continue;
      out.add(`http://${u.hostname}:${u.port}/announce`);
    } else if (u.protocol === 'http:' || u.protocol === 'https:') {
      out.add(u.href);
    }
  }
  return [...out];
}

const encodeBytes = (bytes) => Array.from(bytes, (b) => `%${b.toString(16).padStart(2, '0')}`).join('');

/**
 * Announces and returns { peers: [{host, port}], interval }.
 * opts: { infoHash: Uint8Array, peerId: Uint8Array, left, downloaded, uploaded, event }
 */
export async function announce(relay, trackerUrl, opts) {
  const u = new URL(trackerUrl);
  const query = [
    `info_hash=${encodeBytes(opts.infoHash)}`,
    `peer_id=${encodeBytes(opts.peerId)}`,
    'port=6881',
    `uploaded=${opts.uploaded ?? 0}`,
    `downloaded=${opts.downloaded ?? 0}`,
    `left=${opts.left ?? 0}`,
    'compact=1',
    'numwant=200',
    opts.event ? `event=${opts.event}` : null,
  ].filter(Boolean);
  const existing = u.search.slice(1);
  const path = `${u.pathname}?${existing ? `${existing}&` : ''}${query.join('&')}`;
  if (!noFetch.get(relay.url) && !tunnelOnly.get(trackerUrl) && opts.via !== 'tunnel') {
    try {
      return await announceByFetch(relay, `${u.origin}${path}`);
    } catch (err) {
      if (err.code === 'tracker') throw err; // it answered: a tunnel would get the same
      if (err.code === 'unsupported') noFetch.set(relay.url, true);
      // the Worker couldn't fetch it (an unusual port, say): a tunnel may still reach it
      try {
        const r = await announceByTunnel(relay, u, path);
        tunnelOnly.set(trackerUrl, true);
        return r;
      } catch (err2) {
        throw new Error(`${err2.message}; by fetch: ${err.message}`);
      }
    }
  }
  return announceByTunnel(relay, u, path);
}

async function announceByFetch(relay, fullUrl) {
  const u = new URL('/announce', relay.url);
  u.searchParams.set('url', fullUrl);
  if (relay.token) u.searchParams.set('token', relay.token);
  countRequest();
  let res;
  try {
    res = await fetch(u, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new TrackerError(`relay unreachable: ${err.message}`);
  }
  if (res.status === 404) throw new TrackerError('the relay has no /announce', 'unsupported');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new TrackerError(body.error ?? `relay answered ${res.status}`, 'tracker');
  }
  const status = Number(res.headers.get('x-tracker-status'));
  if (status === 0) {
    // the Worker couldn't fetch it at all: a tunnel may still reach it
    const body = await res.json().catch(() => ({}));
    throw new TrackerError(body.error ?? 'fetch failed');
  }
  if (status !== 200) throw new TrackerError(`tracker answered ${status || 'garbage'}`, 'tracker');
  try {
    return parseBody(new Uint8Array(await res.arrayBuffer()));
  } catch (err) {
    throw new TrackerError(err.message, 'tracker');
  }
}

async function announceByTunnel(relay, u, path) {
  const tls = u.protocol === 'https:';
  const port = Number(u.port) || (tls ? 443 : 80);
  const request = `GET ${path} HTTP/1.0\r\nHost: ${u.host}\r\nUser-Agent: Sayl-relay/0.1\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`;
  const tunnel = await openTunnel(relay, { host: u.hostname, port, tls });
  const chunks = [];
  const body = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tunnel.close();
      reject(new Error('tracker timed out'));
    }, 15_000);
    tunnel.ondata = (b) => chunks.push(b);
    tunnel.onclose = () => {
      clearTimeout(timer);
      resolve(join(chunks));
    };
    tunnel.send(new TextEncoder().encode(request));
  });
  return parseResponse(body);
}

function join(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function parseResponse(raw) {
  let end = -1;
  for (let i = 0; i + 3 < raw.length; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error('tracker sent no HTTP response');
  const head = new TextDecoder().decode(raw.subarray(0, end));
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
  if (status !== 200) throw new Error(`tracker answered ${status || 'garbage'}`);
  let body = raw.subarray(end + 4);
  if (/^transfer-encoding:\s*chunked/im.test(head)) body = unchunk(body);
  return parseBody(body);
}

/** A tracker's bencoded answer: { peers, interval }. */
export function parseBody(body) {
  if (!body.length) throw new Error('tracker sent an empty answer');
  const { value } = decode(body);
  if (value['failure reason']) throw new Error(`tracker refused: ${text(value['failure reason'])}`);
  const peers = [];
  if (value.peers instanceof Uint8Array) {
    for (let i = 0; i + 6 <= value.peers.length; i += 6) {
      const p = value.peers;
      peers.push({ host: `${p[i]}.${p[i + 1]}.${p[i + 2]}.${p[i + 3]}`, port: (p[i + 4] << 8) | p[i + 5] });
    }
  } else if (Array.isArray(value.peers)) {
    for (const p of value.peers) if (p.ip && p.port) peers.push({ host: text(p.ip), port: p.port });
  }
  if (value.peers6 instanceof Uint8Array) {
    const p = value.peers6;
    for (let i = 0; i + 18 <= p.length; i += 18) {
      const groups = [];
      for (let g = 0; g < 8; g++) groups.push(((p[i + g * 2] << 8) | p[i + g * 2 + 1]).toString(16));
      peers.push({ host: groups.join(':'), port: (p[i + 16] << 8) | p[i + 17] });
    }
  }
  return { peers: peers.filter((x) => x.port > 0), interval: Number(value.interval) || 1800 };
}

function unchunk(body) {
  const parts = [];
  let pos = 0;
  for (;;) {
    let lineEnd = pos;
    while (lineEnd + 1 < body.length && !(body[lineEnd] === 13 && body[lineEnd + 1] === 10)) lineEnd++;
    const size = parseInt(new TextDecoder().decode(body.subarray(pos, lineEnd)), 16);
    if (!size) break;
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    pos = lineEnd + 2 + size + 2;
  }
  return join(parts);
}
