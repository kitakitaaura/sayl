#!/usr/bin/env node
/**
 * Can the browser client reach the DHT? This checks, step by step:
 *   1. get TURN credentials (from the relay's /turn-credentials by default)
 *   2. open a TCP connection to Cloudflare's TURN server through the relay
 *   3. allocate a UDP address there
 *   4. ping the DHT's bootstrap nodes through it
 *   5. look up peers for a torrent in the DHT
 *   6. download a few MB from peers found only through the DHT
 *
 *   node cli/turn-check.mjs --relay $RELAY --token $TOKEN
 *
 * options:
 *   --relay <url>            relay address (leave out with --direct)
 *   --token <t>              the relay's ACCESS_TOKEN
 *   --via worker|do          which relay (default do)
 *   --turn-key-id <id>       Cloudflare TURN key id      (or env TURN_KEY_ID)
 *   --turn-api-token <t>     Cloudflare TURN key token   (or env TURN_API_TOKEN)
 *   --direct                 connect to TURN from this computer, not through the relay
 *   --turn-url <url>         use this TURN server instead, e.g. turn:host:3478?transport=tcp
 *   --turn-ip <ip>           connect to this IP address instead of the TURN server's name
 *                            (repeatable; plain TCP only, since TLS needs the name)
 *   --username/--password    credentials for --turn-url
 *   --info-hash <hex>        torrent to look up (default: Debian 13.7.0 netinst)
 *   --bootstrap <host:port>  DHT node to start from (repeatable; default: the public routers)
 *   --download-mb <n>        MB to download from DHT peers at the end (default 20, 0 to skip)
 */
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { parseArgs } from 'node:util';
import { BOOTSTRAP, Dht } from '../../client/dht.js';
import { Download } from '../../client/download.js';
import { fromHex } from '../../client/torrent.js';
import { TurnClient, fetchTurnServers } from '../../client/turn.js';
import { openTunnel } from '../../client/tunnel.js';

const { values: o } = parseArgs({
  options: {
    relay: { type: 'string' },
    token: { type: 'string' },
    via: { type: 'string', default: 'do' },
    'turn-key-id': { type: 'string', default: process.env.TURN_KEY_ID },
    'turn-api-token': { type: 'string', default: process.env.TURN_API_TOKEN },
    direct: { type: 'boolean', default: false },
    'turn-url': { type: 'string' },
    'turn-ip': { type: 'string', multiple: true, default: [] },
    username: { type: 'string' },
    password: { type: 'string' },
    'info-hash': { type: 'string', default: '7acf8fb590b2060dd9c3146ef770169d593433b0' },
    bootstrap: { type: 'string', multiple: true, default: [] },
    'download-mb': { type: 'string', default: '20' },
  },
});

const ok = (m) => console.log(`ok    ${m}`);
const info = (m) => console.log(`      ${m}`);
const fail = (m) => {
  console.log(`FAIL  ${m}`);
  process.exit(1);
};

if (!o.direct && !o.relay) fail('pass --relay (or --direct to skip the relay)');
const relay = o.relay ? { url: o.relay, via: o.via, session: randomBytes(12).toString('base64url'), token: o.token } : null;

// 1. Credentials.
let servers;
if (o['turn-url']) {
  servers = [{ url: o['turn-url'], username: o.username, credential: o.password }];
} else if (o['turn-key-id'] && o['turn-api-token']) {
  servers = await cloudflareTurn(o['turn-key-id'], o['turn-api-token']);
  ok(`got TURN credentials from Cloudflare (${servers.length} TCP/TLS servers: ${servers.map((c) => c.url.replace(/\?.*/, '')).join(', ')})`);
} else {
  if (!relay) fail('pass --relay, --turn-url, or --turn-key-id and --turn-api-token');
  try {
    servers = await fetchTurnServers(relay);
  } catch (err) {
    fail(`the relay gave no TURN login: ${err.message}`);
  }
  if (!servers.length) fail('the relay gave no usable TURN server');
  ok(`got a TURN login from the relay (${servers.map((c) => c.url.replace(/\?.*/, '')).join(', ')})`);
}

if (o['turn-ip'].length) {
  // Same credentials, but aimed at raw IP addresses over plain TCP.
  const plain = servers.filter((c) => /^turn:.*transport=tcp/.test(c.url));
  if (!plain.length) fail('no plain-TCP TURN address to aim at an IP');
  servers = o['turn-ip'].flatMap((ip) =>
    plain.map((c) => ({ ...c, url: c.url.replace(/^turn:[^:?]+/, `turn:${ip.includes(':') ? `[${ip}]` : ip}`) })),
  );
  info(`trying by IP: ${servers.map((c) => c.url.replace(/\?.*/, '')).join(', ')}`);
}

// 2–3. Connect (trying each server until one works) and allocate.
let stream;
let server;
let target;
for (const candidate of servers) {
  target = parseTurnUrl(candidate.url);
  const where = `${target.tls ? 'TLS' : 'TCP'} ${target.host}:${target.port}${o.direct ? ' (direct)' : ` through the relay (${o.via})`}`;
  try {
    stream = o.direct ? await directStream(target) : await openTunnel(relay, target);
    server = candidate;
    ok(`connected: ${where}`);
    break;
  } catch (err) {
    info(`can't connect: ${where}: ${err.message.slice(0, 120)}`);
  }
}
if (!stream) fail(`couldn't reach any TURN server${o.direct ? '' : ' through the relay'}`);
let turn;
try {
  turn = await TurnClient.connect(stream, { username: server.username, password: server.credential });
} catch (err) {
  fail(`TURN allocation failed: ${err.message}`);
}
ok(`TURN gave us a UDP address: ${turn.relayed.host}:${turn.relayed.port}`);

// 4. Ping the bootstrap nodes.
const dht = new Dht(turn);
const boot = [];
for (const b of o.bootstrap.length ? o.bootstrap.map(splitHostPort) : BOOTSTRAP) {
  try {
    const { address } = await lookup(b.host, { family: 4 });
    boot.push({ host: address, port: b.port, name: b.host });
  } catch {
    info(`couldn't resolve ${b.host}`);
  }
}
if (!boot.length) fail('no DHT bootstrap node resolved');
let pongs = 0;
try {
  await Promise.all(
    boot.map(async (b) => {
      const r = await dht.ping(b);
      if (r) pongs++;
      info(`ping ${b.name} (${b.host}:${b.port}): ${r ? 'replied' : 'no reply'}`);
    }),
  );
} catch (err) {
  fail(`TURN refused to send to the DHT: ${err.message}`);
}
if (!pongs) fail('no DHT node answered through TURN. Cloudflare may not relay this traffic.');
ok(`${pongs} of ${boot.length} DHT bootstrap nodes answered through TURN`);

// 5. Look up the torrent.
const started = Date.now();
const result = await dht.getPeers(fromHex(o['info-hash']), boot, {
  onround: (r) => info(`round ${r.round}: asked ${r.asked}, ${r.replies} replied, ${r.peers} peers so far`),
});
const secs = ((Date.now() - started) / 1000).toFixed(1);
if (!result.peers.length) fail(`the DHT lookup found no peers (${result.nodesQueried} nodes asked in ${secs}s)`);
ok(`the DHT found ${result.peers.length} peers in ${secs}s (${result.nodesQueried} nodes asked, ${dht.stats.replies}/${dht.stats.sent} replies)`);

// 6. Download from DHT peers only.
const mb = Number(o['download-mb']);
if (mb > 0 && relay) {
  const d = new Download({
    relay,
    source: { infoHash: o['info-hash'], trackers: [], peers: result.peers.map((p) => `${p.host}:${p.port}`) },
    sink: {},
    extraTrackers: false,
    limitBytes: mb * 1e6,
  });
  const timer = setTimeout(() => d.stop('time limit'), 180_000);
  const s = await d.start();
  clearTimeout(timer);
  if (!s.verifiedBytes) fail(`couldn't download from the DHT peers (${s.peersHandshaken} handshakes, ${s.stopReason})`);
  ok(`downloaded ${(s.verifiedBytes / 1e6).toFixed(0)} MB from DHT-only peers at ${s.averageMBps.toFixed(1)} MB/s (metadata in ${s.metadataSeconds}s)`);
}

turn.close();
console.log(`\nthe DHT works ${o.direct ? 'through TURN (direct, without the relay)' : 'through the relay and TURN'}`);
process.exit(0);

async function cloudflareTurn(keyId, apiToken) {
  const base = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials`;
  let lastError = '';
  for (const path of ['generate-ice-servers', 'generate']) {
    const res = await fetch(`${base}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ttl: 3600 }),
    });
    if (!res.ok) {
      lastError = `${res.status} ${(await res.text()).slice(0, 200)}`;
      continue;
    }
    const body = await res.json();
    const servers = [body.iceServers].flat().filter(Boolean);
    const candidates = [];
    for (const s of servers) for (const url of [s.urls].flat()) candidates.push({ url, username: s.username, credential: s.credential });
    // TCP or TLS only (the relay can't carry UDP); non-web ports first, since Workers may not reach Cloudflare on 80/443.
    const tcp = candidates.filter((c) => c.username && (/^turns:/.test(c.url) || /transport=tcp/.test(c.url)));
    const rank = (c) => (/:(80|443)\b/.test(c.url) ? 1 : 0);
    tcp.sort((a, b) => rank(a) - rank(b));
    if (!tcp.length) fail(`Cloudflare's answer had no TCP TURN server: ${JSON.stringify(body).slice(0, 300)}`);
    return tcp;
  }
  fail(`Cloudflare refused to make TURN credentials: ${lastError}`);
}

function parseTurnUrl(url) {
  const m = /^(turns?):(\[[^\]]+\]|[^:?]+):(\d+)/.exec(url);
  if (!m) fail(`can't read the TURN url ${url}`);
  return { host: m[2].replace(/^\[|\]$/g, ''), port: Number(m[3]), tls: m[1] === 'turns' };
}

function splitHostPort(s) {
  const i = s.lastIndexOf(':');
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
}

/** A plain TCP/TLS socket that looks like a relay tunnel. */
function directStream({ host, port, tls: secure }) {
  return new Promise((resolve, reject) => {
    const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    const s = {
      ondata: null,
      onclose: null,
      send: (b) => socket.write(b),
      close: () => socket.destroy(),
    };
    socket.on(secure ? 'secureConnect' : 'connect', () => resolve(s));
    socket.on('data', (b) => s.ondata?.(new Uint8Array(b)));
    socket.on('close', () => s.onclose?.());
    socket.on('error', reject);
  });
}
