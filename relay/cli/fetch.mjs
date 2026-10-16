#!/usr/bin/env node
/**
 * Downloads a torrent through the relay from Node, with the same client code
 * the browser page uses, and prints what happened. This is the measurement
 * tool for the experiment.
 *
 *   node cli/fetch.mjs --relay https://sayl-relay.<you>.workers.dev --debian --limit-mb 200
 *
 * options:
 *   --relay <url>        relay address (required)
 *   --token <t>          the relay's ACCESS_TOKEN, if set
 *   --via worker|do      relay inside the Worker (default) or a Durable Object
 *   --magnet <uri>       download this magnet
 *   --torrent <path|url> download this .torrent
 *   --debian             download the current Debian netinst ISO (official, legal)
 *   --peer <host:port>   also connect to this peer (repeatable)
 *   --no-extra-trackers  only use the torrent's own trackers
 *   --no-dht             never use the DHT (by default it's the last resort, if the relay has TURN set up)
 *   --turn-from <url>    when the relay has no TURN login, get one here (e.g. https://sayl.kitaaura.com/api/turn)
 *   --max-peers <n>      connections at once (default 40)
 *   --limit-mb <n>       stop after this many verified MB (default: whole torrent)
 *   --time-limit <s>     stop after this many seconds (default 600)
 *   --out <path>         write the data to this file (default: count it only)
 *   --sha256 <hex>       check the finished file against this SHA-256 (needs --out)
 *   --json               print the summary as JSON only
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Download } from '../../client/download.js';
import { parseMagnet, parseTorrentFile } from '../../client/torrent.js';
import { fetchTurnServers } from '../../client/turn.js';

const DEBIAN = 'https://cdimage.debian.org/debian-cd/current/amd64/';

const { values: o } = parseArgs({
  options: {
    relay: { type: 'string' },
    token: { type: 'string' },
    via: { type: 'string', default: 'worker' },
    magnet: { type: 'string' },
    torrent: { type: 'string' },
    debian: { type: 'boolean', default: false },
    peer: { type: 'string', multiple: true, default: [] },
    'no-extra-trackers': { type: 'boolean', default: false },
    'no-dht': { type: 'boolean', default: false },
    'turn-from': { type: 'string' },
    'max-peers': { type: 'string', default: '40' },
    'limit-mb': { type: 'string' },
    'time-limit': { type: 'string', default: '600' },
    out: { type: 'string' },
    sha256: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

const say = (...a) => {
  if (!o.json) console.error(...a);
};
const die = (m) => {
  console.error(`error: ${m}`);
  process.exit(1);
};

if (!o.relay) die('--relay is required');
if (!['worker', 'do'].includes(o.via)) die('--via must be worker or do');
if (o.sha256 && !o.out) die('--sha256 needs --out');

let source;
let sha256 = o.sha256?.toLowerCase();
if (o.magnet) {
  source = parseMagnet(o.magnet);
} else if (o.torrent || o.debian) {
  let url = o.torrent;
  if (o.debian) {
    const listing = await (await fetch(`${DEBIAN}bt-cd/`)).text();
    const name = /href="(debian-[\d.]+-amd64-netinst\.iso)\.torrent"/.exec(listing)?.[1];
    if (!name) die(`couldn't find the netinst .torrent on ${DEBIAN}bt-cd/`);
    url = `${DEBIAN}bt-cd/${name}.torrent`;
    if (o.out && !sha256) {
      const sums = await (await fetch(`${DEBIAN}iso-cd/SHA256SUMS`)).text();
      sha256 = new RegExp(`^([0-9a-f]{64})\\s+${name.replace(/\./g, '\\.')}$`, 'm').exec(sums)?.[1];
    }
  }
  const bytes = /^https?:\/\//.test(url) ? new Uint8Array(await (await fetch(url)).arrayBuffer()) : new Uint8Array(await readFile(url));
  source = await parseTorrentFile(bytes);
} else {
  die('pass --magnet, --torrent or --debian');
}
source.peers = [...(source.peers ?? []), ...o.peer];

let file = null;
const sink = {
  async open(info) {
    if (o.out) {
      file = await open(o.out, 'w+');
      await file.truncate(info.length);
    }
  },
  async write(offset, bytes) {
    if (file) await file.write(bytes, 0, bytes.length, offset);
  },
  async close() {
    await file?.close();
  },
};

const relay = { url: o.relay, via: o.via, session: randomBytes(12).toString('base64url'), token: o.token };
const download = new Download({
  relay,
  source,
  sink,
  maxPeers: Number(o['max-peers']),
  limitBytes: o['limit-mb'] ? Number(o['limit-mb']) * 1e6 : Infinity,
  extraTrackers: !o['no-extra-trackers'],
  dht: o['no-dht'] ? null : { getTurn: () => fetchTurnServers(relay, { fallback: o['turn-from'] }) },
  log: say,
});

say(`relay ${o.relay} via ${o.via} · info hash ${source.infoHash}`);
let lastPrint = 0;
download.onprogress = (p) => {
  if (Date.now() - lastPrint < 2000) return;
  lastPrint = Date.now();
  const pct = p.size ? `${(p.fraction * 100).toFixed(1)}%` : 'getting metadata';
  say(`${pct} · ${(p.bytesPerSecond / 1e6).toFixed(2)} MB/s · ${p.peersConnected} connected (${p.peersUnchoked} sending) · ${p.peersKnown} known`);
};
const timer = setTimeout(() => download.stop('time limit'), Number(o['time-limit']) * 1000);
const summary = await download.start();
clearTimeout(timer);

if (sha256 && summary.complete) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(o.out)) h.update(chunk);
  summary.sha256 = h.digest('hex') === sha256 ? 'match' : 'MISMATCH';
}
console.log(o.json ? JSON.stringify(summary) : JSON.stringify(summary, null, 2));
process.exit(summary.verifiedBytes > 0 && summary.sha256 !== 'MISMATCH' ? 0 : 2);
