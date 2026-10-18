#!/usr/bin/env node
/**
 * End-to-end test on one machine, no internet needed:
 *   a real qBittorrent (Docker) seeds a random file,
 *   a fake HTTP tracker points at it,
 *   `wrangler dev` runs the relay locally,
 *   and the client downloads the file through the relay, both ways
 *   (.torrent via the Worker, magnet via a Durable Object), checking SHA-256.
 * It also checks that the relay refuses traffic that isn't BitTorrent.
 *
 * Needs Docker and the linuxserver/qbittorrent:5.2.4 image.
 *   node test/local.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '../../client/bencode.js';
import { Dht } from '../../client/dht.js';
import { createTorrent } from '../../client/create.js';
import { Download } from '../../client/download.js';
import { RateLimiter } from '../../client/limiter.js';
import { fromHex, parseTorrentFile } from '../../client/torrent.js';
import { TurnClient, fetchTurnServers } from '../../client/turn.js';
import { openTunnel } from '../../client/tunnel.js';
import { turnLogins } from '../worker/turn-login.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const QBIT_PORT = 16881;
const WEBUI_PORT = 18080;
const RELAY_PORT = 18787;
const CONTAINER = 'sayl-relay-test-qbit';
const SIZE = 40 * 1024 * 1024 + 12345; // not a multiple of the piece size, to test the short last piece
const PIECE = 256 * 1024;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};

const work = mkdtempSync(join(tmpdir(), 'sayl-relay-'));
const cleanups = [];
const cleanup = () => {
  for (const c of cleanups.reverse()) {
    try {
      c();
    } catch {}
  }
};
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

try {
  // 1. A random file and its .torrent.
  const downloads = join(work, 'downloads');
  mkdirSync(downloads);
  const payload = randomBytes(SIZE);
  writeFileSync(join(downloads, 'payload.bin'), payload);
  const payloadSha = createHash('sha256').update(payload).digest('hex');
  const hashes = [];
  for (let o = 0; o < SIZE; o += PIECE) hashes.push(createHash('sha1').update(payload.subarray(o, o + PIECE)).digest());
  const info = { name: 'payload.bin', length: SIZE, 'piece length': PIECE, pieces: new Uint8Array(Buffer.concat(hashes)) };

  // 2. A fake tracker that hands out the seeder's address.
  let announces = 0;
  const tracker = createServer((req, res) => {
    announces++;
    const peer = Buffer.from([127, 0, 0, 1, QBIT_PORT >> 8, QBIT_PORT & 255]);
    res.end(Buffer.from(encode({ interval: 60, peers: new Uint8Array(peer) })));
  });
  await new Promise((r) => tracker.listen(0, '127.0.0.1', r));
  cleanups.push(() => tracker.close());
  const trackerUrl = `http://127.0.0.1:${tracker.address().port}/announce`;
  const torrentBytes = encode({ announce: trackerUrl, info });
  const torrent = await parseTorrentFile(torrentBytes);
  console.log(`payload ${SIZE} bytes, ${hashes.length} pieces, info hash ${torrent.infoHash}`);

  // 3. qBittorrent seeding it.
  const config = join(work, 'config');
  const password = randomBytes(12).toString('hex');
  execFileSync('node', [join(root, '../deploy/qbit-init/init.mjs')], {
    env: { ...process.env, QBIT_USERNAME: 'admin', QBIT_PASSWORD: password, TORRENT_PORT: String(QBIT_PORT), QBIT_CONFIG_DIR: join(config, 'qBittorrent') },
    stdio: 'inherit',
  });
  for (const d of [work, downloads, config, join(config, 'qBittorrent')]) chmodSync(d, 0o777);
  chmodSync(join(downloads, 'payload.bin'), 0o666);
  execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  execFileSync('docker', [
    'run', '-d', '--name', CONTAINER,
    '-e', 'PUID=1000', '-e', 'PGID=1000', '-e', `WEBUI_PORT=${WEBUI_PORT}`, '-e', `TORRENTING_PORT=${QBIT_PORT}`,
    '-p', `127.0.0.1:${QBIT_PORT}:${QBIT_PORT}`, '-p', `127.0.0.1:${WEBUI_PORT}:${WEBUI_PORT}`,
    '-v', `${config}:/config`, '-v', `${downloads}:/downloads`,
    'linuxserver/qbittorrent:5.2.4',
  ], { stdio: 'ignore' });
  cleanups.push(() => execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' }));

  const qbit = `http://127.0.0.1:${WEBUI_PORT}`;
  let cookie;
  await until(async () => {
    const r = await fetch(`${qbit}/api/v2/auth/login`, { method: 'POST', body: new URLSearchParams({ username: 'admin', password }) });
    cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => /SID/.test(c));
    return r.status === 204 || r.status === 200 ? cookie : null;
  }, 60, 'qbittorrent web api');
  const form = new FormData();
  form.append('torrents', new Blob([torrentBytes]), 'payload.torrent');
  form.append('savepath', '/downloads');
  form.append('contentLayout', 'Original');
  const added = await fetch(`${qbit}/api/v2/torrents/add`, { method: 'POST', body: form, headers: { cookie } });
  if (!added.ok) throw new Error(`qbittorrent refused the torrent: ${added.status}`);
  await until(async () => {
    const [t] = await (await fetch(`${qbit}/api/v2/torrents/info`, { headers: { cookie } })).json();
    return t && t.progress === 1 && /UP$/.test(t.state);
  }, 60, 'qbittorrent seeding');
  check('qbittorrent is seeding the test file', true);

  // A TURN server for the DHT tests (step 8), if coturn is installed. The relay hands out its login.
  let hasCoturn = true;
  try {
    execFileSync('which', ['turnserver'], { stdio: 'ignore' });
  } catch {
    hasCoturn = false;
  }
  const turnPort = 13478;
  const turnUser = 'sayl';
  const turnPass = randomBytes(8).toString('hex');
  if (hasCoturn) {
    const coturn = spawn('turnserver', [
      '-n', '--listening-ip', '127.0.0.1', '--relay-ip', '127.0.0.1', '--listening-port', String(turnPort),
      '--lt-cred-mech', '--user', `${turnUser}:${turnPass}`, '--realm', 'sayl.test',
      '--allow-loopback-peers', '--no-tls', '--no-dtls', '--no-cli', '--log-file', 'stdout', '--simple-log',
    ], { stdio: 'ignore' });
    cleanups.push(() => coturn.kill('SIGTERM'));
  }
  const turnVars = hasCoturn
    ? ['--var', `TURN_URLS:turn:127.0.0.1:${turnPort}?transport=tcp`, '--var', `TURN_USERNAME:${turnUser}`, '--var', `TURN_CREDENTIAL:${turnPass}`]
    : [];

  // 4. The relay, running locally.
  const wrangler = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--persist-to', join(work, 'relay-state'), '--var', 'ALLOW_PRIVATE_TARGETS:1', '--var', 'TURN_HOSTS:127.0.0.1', ...turnVars], {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wranglerLog = '';
  wrangler.stdout.on('data', (d) => (wranglerLog += d));
  wrangler.stderr.on('data', (d) => (wranglerLog += d));
  cleanups.push(() => wrangler.kill('SIGTERM'));
  const relayUrl = `http://127.0.0.1:${RELAY_PORT}`;
  await until(async () => (await fetch(`${relayUrl}/health`)).ok, 60, `wrangler dev\n${wranglerLog}`);
  check('relay is up', true);

  // 5. Refusals.
  check('refuses non-bittorrent bytes', (await rawTunnel(relayUrl, { host: '127.0.0.1', port: QBIT_PORT }, [new TextEncoder().encode('hello there\r\n')])).error?.includes('only bittorrent'));
  check(
    'refuses an HTTP request that is not an announce',
    (await rawTunnel(relayUrl, { host: '127.0.0.1', port: tracker.address().port }, [new TextEncoder().encode('GET /admin HTTP/1.1\r\nHost: x\r\n\r\n')])).error?.includes('only bittorrent'),
  );
  const handshake = new Uint8Array([19, ...new TextEncoder().encode('BitTorrent protocol'), 0, 0, 0, 0, 0, 0, 0, 0, ...randomBytes(40)]);
  check(
    'refuses a remote that does not answer like a peer',
    (await rawTunnel(relayUrl, { host: '127.0.0.1', port: tracker.address().port }, [handshake, new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n')])).error?.includes('not a bittorrent peer'),
  );
  const announce = new TextEncoder().encode('GET /announce?info_hash=%00 HTTP/1.0\r\nHost: x\r\n\r\n');
  check(
    'allows one announce per tunnel',
    (await rawTunnel(relayUrl, { host: '127.0.0.1', port: tracker.address().port }, [announce, announce])).error?.includes('one announce'),
  );

  // 5b. The shared torrent list: per torrent, the newer change wins; removals stay as markers.
  {
    const post = async (entries) => (await fetch(`${relayUrl}/list`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ entries }) })).json();
    const h = (n) => n.toString(16).padStart(40, '0');
    const t = Date.now() - 60_000;
    await post([{ hash: h(1), name: 'one', trackers: ['http://t/announce'], addedAt: t + 100, updatedAt: t + 100 }]);
    await post([{ hash: h(1), name: 'older', trackers: [], addedAt: t + 100, updatedAt: t + 50 }, { hash: 'nothex', name: 'bad', updatedAt: t }]);
    // more than the 128 keys storage takes per call
    const many = Array.from({ length: 150 }, (_, i) => ({ hash: h(1000 + i), name: `n${i}`, trackers: [], addedAt: t + 10, updatedAt: t + 10 }));
    await post(many);
    const removed = await post([{ hash: h(1000), name: 'n0', trackers: [], addedAt: t + 10, updatedAt: t + 300, removed: true }]);
    // a removal older than 30 days is forgotten
    await post([{ hash: h(2), name: 'old', trackers: [], addedAt: 1, updatedAt: Date.now() - 31 * 24 * 3600_000, removed: true }]);
    const got = await (await fetch(`${relayUrl}/list`)).json();
    const one = got.entries.find((e) => e.hash === h(1));
    check(
      'the relay keeps a shared torrent list: newer wins, bad entries are dropped, removals are kept as markers',
      one?.name === 'one' &&
        got.entries.length === 151 &&
        !got.entries.some((e) => e.name === 'bad' || e.hash === h(2)) &&
        removed.entries.find((e) => e.hash === h(1000))?.removed === true,
      `${got.entries.length} entries`,
    );
  }

  // 6. Downloads.
  for (const run of [
    { label: '.torrent via the worker', via: 'worker', source: { ...torrent, peers: [] } },
    { label: 'magnet via a durable object (metadata from the peer)', via: 'do', source: { infoHash: torrent.infoHash, trackers: [trackerUrl], peers: [] } },
  ]) {
    const out = new Uint8Array(SIZE);
    const sink = { open: (i) => check(`${run.label}: metadata`, i.length === SIZE && i.name === 'payload.bin'), write: (offset, b) => out.set(b, offset) };
    const relay = { url: relayUrl, via: run.via, session: randomBytes(12).toString('base64url') };
    const d = new Download({ relay, source: run.source, sink, extraTrackers: false });
    const timer = setTimeout(() => d.stop('time limit'), 120_000);
    const s = await d.start();
    clearTimeout(timer);
    const sha = createHash('sha256').update(out).digest('hex');
    check(`${run.label}: complete and identical`, s.complete && sha === payloadSha, `${(s.averageMBps).toFixed(1)} MB/s, ${s.hashFailures} hash failures, ${s.wastedBytes} wasted bytes, trackers ${JSON.stringify(s.trackers)}`);
  }
  check('the tracker was asked through the relay', announces >= 2, `${announces} announces`);

  // 6a. A download speed limit holds.
  {
    const relay = { url: relayUrl, via: 'do', session: randomBytes(12).toString('base64url') };
    const d = new Download({ relay, source: { ...torrent, peers: [] }, sink: {}, extraTrackers: false, limitBytes: 12e6, limits: { download: new RateLimiter(3e6) } });
    const started = Date.now();
    const s = await d.start();
    const secs = (Date.now() - started) / 1000;
    const rate = s.verifiedBytes / 1e6 / secs;
    check('a 3 MB/s download limit holds', s.verifiedBytes >= 12e6 && rate < 3.6 && secs > 2.5, `${rate.toFixed(2)} MB/s over ${secs.toFixed(1)} s`);
  }

  // 6b. Waiting for a choice of pieces, fetching only those, in order, then resuming for the rest.
  {
    const half = Math.floor(hashes.length / 2);
    const firstHalf = new Uint8Array(hashes.length).fill(1, 0, half);
    const out = new Uint8Array(SIZE);
    const order = [];
    let selectedAt = Infinity;
    let earlyWrites = 0;
    const sink = {
      write: (offset, b, piece) => {
        if (Date.now() < selectedAt) earlyWrites++;
        order.push(piece);
        out.set(b, offset);
      },
    };
    const relay = { url: relayUrl, via: 'worker' };
    const first = new Download({ relay, source: { infoHash: torrent.infoHash, trackers: [trackerUrl], peers: [] }, sink, extraTrackers: false, wanted: null, sequential: true });
    let metadataSeen = false;
    first.onmetadata = () => {
      metadataSeen = true;
      setTimeout(() => {
        selectedAt = Date.now();
        first.select(firstHalf);
      }, 1500);
    };
    const t1 = setTimeout(() => first.stop('time limit'), 120_000);
    const s1 = await first.start();
    clearTimeout(t1);
    check(
      'waits for a choice after the metadata, then fetches only the chosen pieces',
      metadataSeen && s1.complete && earlyWrites === 0 && order.length === half && order.every((p) => firstHalf[p]),
      `${order.length} pieces, first ones: ${order.slice(0, 5).join(',')}`,
    );
    check('sequential mode starts at the beginning', order[0] < 4, `first piece ${order[0]}`);
    const have = first.have;
    const second = new Download({ relay, source: { ...torrent, peers: [] }, sink, extraTrackers: false, wanted: 'all', have });
    const t2 = setTimeout(() => second.stop('time limit'), 120_000);
    const s2 = await second.start();
    clearTimeout(t2);
    const sha = createHash('sha256').update(out).digest('hex');
    check(
      'resuming fetches only what is missing, and the file comes out whole',
      s2.complete && s2.verifiedBytes === SIZE - half * PIECE && sha === payloadSha,
      `${s2.verifiedBytes} bytes fetched on resume`,
    );
  }

  // 7. The command-line tool, writing to a file.
  const torrentPath = join(work, 'payload.torrent');
  writeFileSync(torrentPath, torrentBytes);
  const outPath = join(work, 'out.bin');
  const cli = spawn('node', [join(root, 'cli/fetch.mjs'), '--relay', relayUrl, '--torrent', torrentPath, '--no-extra-trackers', '--out', outPath, '--sha256', payloadSha, '--time-limit', '120', '--json'], { cwd: root });
  let cliOut = '';
  cli.stdout.on('data', (d) => (cliOut += d));
  cli.stderr.on('data', (d) => (cliOut += d));
  const code = await new Promise((r) => cli.on('close', r));
  const cliSummary = safeJson(cliOut.trim().split('\n').pop());
  check('cli downloads to a file and the sha-256 matches', code === 0 && cliSummary?.sha256 === 'match' && readFileSync(outPath).length === SIZE, cliOut.slice(-300).replace(/\s+/g, ' '));

  // 7b. Seeding: Sayl makes a torrent and seeds it; qBittorrent gets it from a bare magnet (metadata from us too).
  {
    const a = randomBytes(3 * 1024 * 1024 + 7);
    const c = randomBytes(5 * 1024 * 1024 + 1);
    const all = Buffer.concat([a, c]);
    const made = await createTorrent({
      name: 'sayl-share',
      files: [
        { path: ['a.bin'], blob: new Blob([a]) },
        { path: ['sub', 'c.bin'], blob: new Blob([c]) },
      ],
      trackers: [trackerUrl],
    });
    const { pieceLength, pieceCount } = made.info;
    // a 2 MB/s upload limit that notes when it lets bytes through
    const upLimit = new (class extends RateLimiter {
      bytes = 0;
      take(n) {
        const ok = super.take(n);
        if (ok) {
          this.first ??= Date.now();
          this.last = Date.now();
          this.bytes += n;
        }
        return ok;
      }
    })(2e6);
    let reads = 0;
    const seeder = new Download({
      relay: { url: relayUrl, via: 'do', session: randomBytes(12).toString('base64url') },
      source: { infoHash: made.infoHash, trackers: [trackerUrl], peers: [], info: made.info },
      sink: {},
      wanted: 'all',
      have: new Uint8Array(pieceCount).fill(1),
      seed: true,
      read: async (p) => {
        reads++;
        return new Uint8Array(all.subarray(p * pieceLength, p * pieceLength + made.info.pieceSize(p)));
      },
      extraTrackers: false,
      limits: { upload: upLimit },
    });
    let seedingFromStart = false;
    seeder.oncomplete = () => (seedingFromStart = true);
    const seeding = seeder.start();
    const qbitAdd = await fetch(`${qbit}/api/v2/torrents/add`, {
      method: 'POST',
      body: new URLSearchParams({ urls: `magnet:?xt=urn:btih:${made.infoHash}&tr=${encodeURIComponent(trackerUrl)}`, savepath: '/downloads/fromsayl' }),
      headers: { cookie },
    });
    check('qbittorrent takes the magnet of a torrent made by sayl', qbitAdd.ok);
    let qt = null;
    try {
      await until(async () => {
        qt = (await (await fetch(`${qbit}/api/v2/torrents/info?hashes=${made.infoHash}`, { headers: { cookie } })).json())[0];
        return qt && qt.progress === 1;
      }, 120, 'qbittorrent to download from the sayl seeder');
    } catch {}
    const got = (p) => {
      try {
        return readFileSync(join(downloads, 'fromsayl', 'sayl-share', ...p));
      } catch {
        return Buffer.alloc(0);
      }
    };
    check(
      'qbittorrent got the metadata and every file from the sayl seeder, intact',
      qt?.progress === 1 && got(['a.bin']).equals(a) && got(['sub', 'c.bin']).equals(c),
      qt?.state,
    );
    const p = seeder.progress();
    // after the first second's worth (2 MB, allowed at once), the rest goes at the limit
    const upSecs = (upLimit.last - upLimit.first) / 1000;
    const upRate = (upLimit.bytes - 2e6) / 1e6 / Math.max(upSecs, 0.001);
    check('a 2 MB/s upload limit holds', upRate < 2.3 && upSecs > 2.5, `${upRate.toFixed(2)} MB/s over ${upSecs.toFixed(1)} s`);
    check('the seeder counts what it uploaded, and read pieces back to do it', p.seeding && seedingFromStart && p.uploadedBytes >= all.length && reads >= pieceCount, `${p.uploadedBytes} bytes, ${reads} reads`);
    await until(async () => seeder.progress().peersConnected === 0, 30, 'the seeder to let go of a finished peer').catch(() => {});
    check('once qbittorrent is a seed too, the seeder lets go of it', seeder.progress().peersConnected === 0);
    seeder.stop('done');
    const summary = await seeding;
    check('a seeder never asks the DHT', summary.dht === 'off' && summary.stopReason === 'done', summary.dht);
  }

  // 8. The DHT over TURN, through the relay (skipped unless coturn is installed).
  if (!hasCoturn) {
    console.log('skip the DHT over TURN (install coturn to run it)');
  } else {
    // A fake DHT node that knows the seeder.
    const node = createSocket('udp4');
    let dhtQueries = 0;
    node.on('message', (buf, from) => {
      let q;
      try {
        q = decode(new Uint8Array(buf)).value;
      } catch {
        return;
      }
      dhtQueries++;
      const r = { id: new Uint8Array(20).fill(7) };
      if (new TextDecoder().decode(q.q) === 'get_peers') {
        r.token = new TextEncoder().encode('tk');
        r.values = [new Uint8Array([127, 0, 0, 1, QBIT_PORT >> 8, QBIT_PORT & 255])];
      }
      node.send(Buffer.from(encode({ t: q.t, y: 'r', r })), from.port, from.address);
    });
    await new Promise((r) => node.bind(0, '127.0.0.1', r));
    cleanups.push(() => node.close());


    const relay = { url: relayUrl, via: 'do', session: randomBytes(12).toString('base64url') };
    const allocate = new Uint8Array([0, 3, 0, 8, 0x21, 0x12, 0xa4, 0x42, ...randomBytes(12), 0, 0x19, 0, 4, 17, 0, 0, 0]);
    check(
      'refuses TURN to a host outside TURN_HOSTS',
      (await rawTunnel(relayUrl, { host: 'localhost', port: tracker.address().port }, [allocate])).error?.includes('only bittorrent'),
    );
    const stream = await openTunnel(relay, { host: '127.0.0.1', port: turnPort });
    const turn = await TurnClient.connect(stream, { username: turnUser, password: turnPass });
    check('TURN allocation through the relay', !!turn.relayed?.port, `udp ${turn.relayed?.host}:${turn.relayed?.port}`);
    const dht = new Dht(turn);
    const bootstrap = [{ host: '127.0.0.1', port: node.address().port }];
    check('DHT ping through TURN', !!(await dht.ping(bootstrap[0])));
    const found = await dht.getPeers(fromHex(torrent.infoHash), bootstrap);
    check('DHT lookup through TURN finds the seeder', found.peers.some((p) => p.port === QBIT_PORT), `${found.peers.length} peers, ${dhtQueries} queries`);
    turn.close();

    const logins = await fetchTurnServers(relay);
    check('the relay hands out the TURN login', logins.length === 1 && logins[0].username === turnUser);

    const run = async (label, source, dht, seconds = 120) => {
      const out = new Uint8Array(SIZE);
      const d = new Download({ relay: { ...relay, session: randomBytes(12).toString('base64url') }, source, sink: { write: (offset, b) => out.set(b, offset) }, extraTrackers: false, dht });
      const timer = setTimeout(() => d.stop('time limit'), seconds * 1000);
      const summary = await d.start();
      clearTimeout(timer);
      return { summary, ok: summary.complete && createHash('sha256').update(out).digest('hex') === payloadSha };
    };
    const dhtOptions = { getTurn: () => fetchTurnServers(relay), bootstrap };

    const viaTracker = await run('tracker', { infoHash: torrent.infoHash, trackers: [trackerUrl], peers: [] }, dhtOptions);
    check('the DHT stays unused when trackers find peers', viaTracker.ok && viaTracker.summary.dht === 'not needed', viaTracker.summary.dht);

    const queriesBefore = dhtQueries;
    const bare = await run('bare', { infoHash: torrent.infoHash, trackers: [], peers: [] }, dhtOptions);
    check(
      'bare magnet, no trackers: the DHT is the last resort and the file arrives intact',
      bare.ok && /^found [1-9]/.test(bare.summary.dht) && bare.summary.peersFrom.dht >= 1 && dhtQueries > queriesBefore,
      `${bare.summary.dht}, ${bare.summary.averageMBps.toFixed(1)} MB/s`,
    );

    // A relay with no TURN login of its own, like one made by "set up with cloudflare": the login comes from the
    // website's /api/turn instead (served here by the same code the website's Worker runs).
    let siteTurnHits = 0;
    const standIn = createServer(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/turn-credentials')) return res.end(JSON.stringify({ servers: [], error: 'the DHT is not set up here' }));
      if (req.url === '/api/turn') {
        siteTurnHits++;
        const { status, body } = await turnLogins({ TURN_URLS: `turn:127.0.0.1:${turnPort}?transport=tcp`, TURN_USERNAME: turnUser, TURN_CREDENTIAL: turnPass });
        res.statusCode = status;
        return res.end(JSON.stringify(body));
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((r) => standIn.listen(0, '127.0.0.1', r));
    cleanups.push(() => standIn.close());
    const standInUrl = `http://127.0.0.1:${standIn.address().port}`;
    const siteDht = { getTurn: () => fetchTurnServers({ url: standInUrl, token: relay.token }, { fallback: `${standInUrl}/api/turn` }), bootstrap };
    const viaSite = await run('site-turn', { infoHash: torrent.infoHash, trackers: [], peers: [] }, siteDht);
    check(
      "a relay without a TURN login: the DHT uses the website's login and the file arrives intact",
      viaSite.ok && /^found [1-9]/.test(viaSite.summary.dht) && siteTurnHits >= 1,
      `${viaSite.summary.dht}, ${siteTurnHits} logins from the website`,
    );

    // Last, because a refused login switches the DHT off for this process for an hour.
    const broken = await run('broken', { infoHash: torrent.infoHash, trackers: [], peers: [] }, { getTurn: async () => [{ ...logins[0], credential: 'wrong' }], bootstrap }, 25);
    check('a refused TURN login is handled: no crash, the download just has no DHT', broken.summary.stopReason === 'time limit' && /^unavailable: TURN refused/.test(broken.summary.dht), broken.summary.dht);
  }
} catch (err) {
  check(`unexpected error: ${err.message}`, false);
} finally {
  cleanup();
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

async function until(fn, seconds, what) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Opens a tunnel, sends the messages, and returns how it ended: { error, data }. */
function rawTunnel(relayUrl, { host, port }, messages) {
  return new Promise((resolve) => {
    const u = new URL('/tunnel', relayUrl.replace(/^http/, 'ws'));
    u.searchParams.set('host', host);
    u.searchParams.set('port', String(port));
    const ws = new WebSocket(u);
    ws.binaryType = 'arraybuffer';
    let error = null;
    let data = 0;
    const timer = setTimeout(() => ws.close(), 5000);
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return void (data += e.data.byteLength);
      const msg = JSON.parse(e.data);
      if (msg.t === 'open') for (const m of messages) ws.send(m);
      if (msg.t === 'error') error = msg.m;
    });
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      resolve({ error, data });
    });
  });
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
