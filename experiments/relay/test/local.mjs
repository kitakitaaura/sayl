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
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '../public/client/bencode.js';
import { Download } from '../public/client/download.js';
import { parseTorrentFile } from '../public/client/torrent.js';

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
  execFileSync('node', [join(root, '../../deploy/qbit-init/init.mjs')], {
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

  // 4. The relay, running locally.
  const wrangler = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--var', 'ALLOW_PRIVATE_TARGETS:1'], {
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

  // 8. The test page in a real browser (skipped unless playwright-core is installed).
  const pw = await import('playwright-core').catch(() => null);
  if (!pw) {
    console.log('skip the browser page (npm install --no-save playwright-core to run it)');
  } else {
    const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
    cleanups.push(() => browser.close());
    const page = await browser.newPage();
    const consoleLines = [];
    page.on('console', (m) => consoleLines.push(m.text()));
    page.on('pageerror', (e) => consoleLines.push(`page error: ${e.message}`));
    await page.goto(`${relayUrl}/`);
    await page.fill('#source', `magnet:?xt=urn:btih:${torrent.infoHash}&tr=${encodeURIComponent(trackerUrl)}`);
    await page.selectOption('#mode', 'test');
    await page.click('#start');
    await page
      .waitForFunction(() => document.getElementById('log').textContent.includes('summary (paste this back)'), null, { timeout: 120_000 })
      .catch(async (err) => {
        throw new Error(`${err.message.split('\n')[0]} · status: ${await page.textContent('#status')} · log: ${await page.textContent('#log')} · console: ${consoleLines.join(' | ')}`);
      });
    const text = await page.textContent('#log');
    const pageSummary = safeJson(text.slice(text.indexOf('{')));
    check('the browser page downloads and verifies the whole torrent', pageSummary?.complete === true && pageSummary.verifiedBytes === SIZE, `${pageSummary?.averageMBps?.toFixed(1)} MB/s`);
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
