/**
 * HTTP(S) tracker announces, sent through a relay tunnel. Workers can't use
 * UDP, so a udp:// tracker is tried over HTTP on the same host and port
 * (many big trackers, opentrackr among them, answer both). The public
 * trackers asked for every torrent are in public-trackers.js.
 */
import { decode, text } from './bencode.js';
import { openTunnel } from './tunnel.js';

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
  const tls = u.protocol === 'https:';
  const port = Number(u.port) || (tls ? 443 : 80);
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
