#!/usr/bin/env node
/**
 * Tests direct connections (WebRTC) end to end, in Chromium:
 *   a real WebTorrent tracker (bittorrent-tracker) stands in for the public
 *   wss:// ones (the pages' connections to those are routed to it), two Sayl
 *   tabs trade a shared folder with each other directly, and Sayl and the
 *   WebTorrent client itself trade files both ways. Also: with the setting
 *   off, nothing goes direct.
 *
 * Needs playwright-core, bittorrent-tracker and webtorrent (test-only):
 *   npm install --no-save playwright-core@1.56.1 bittorrent-tracker@11.2.3 webtorrent@3.0.21
 *   node test/webrtc.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const frontend = join(root, '../frontend');
const RELAY_PORT = 18797;
const SITE_PORT = 18183;
const TRACKER_PORT = 18200;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const work = mkdtempSync(join(tmpdir(), 'sayl-webrtc-'));
const cleanups = [];
const cleanup = () => {
  for (const c of cleanups.reverse()) {
    try {
      c();
    } catch {}
  }
};

try {
  // 1. A WebTorrent tracker, as the public ones run it.
  const { Server } = await import(join(root, 'node_modules/bittorrent-tracker/index.js'));
  const tracker = new Server({ udp: false, http: false, ws: true, stats: false });
  const trackerSockets = new Set();
  tracker.on('start', (peerId) => trackerSockets.add(peerId));
  tracker.on('update', (peerId) => trackerSockets.add(peerId));
  await new Promise((r) => tracker.listen(TRACKER_PORT, '127.0.0.1', r));
  cleanups.push(() => tracker.close());
  const trackerUrl = `ws://127.0.0.1:${TRACKER_PORT}`;

  // 2. A relay (the site wants one; nothing here is reachable through it).
  const wrangler = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--persist-to', join(work, 'relay-state'), '--var', 'ALLOW_PRIVATE_TARGETS:1'], {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    stdio: 'ignore',
  });
  cleanups.push(() => wrangler.kill('SIGTERM'));
  const relayUrl = `http://127.0.0.1:${RELAY_PORT}`;
  await until(async () => (await fetch(`${relayUrl}/health`)).ok, 60, 'wrangler dev');

  // 3. The website (browser mode), plus a page running the WebTorrent client.
  execFileSync('npm', ['run', 'build'], { cwd: frontend, env: { ...process.env, ENGINE: 'browser', API_URL: '' }, stdio: 'ignore' });
  const site = join(frontend, 'build');
  const wtBundle = readFileSync(join(root, 'node_modules/webtorrent/dist/webtorrent.min.js'));
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/wt.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(wtBundle);
    }
    if (path === '/wt.html') {
      res.setHeader('content-type', 'text/html');
      return res.end('<!doctype html><title>webtorrent</title><script type="module">import WebTorrent from "/wt.js"; window.WebTorrent = WebTorrent; window.ready = true;</script>');
    }
    let p = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    let file = join(site, p);
    if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!existsSync(file)) file = join(site, '404.html');
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(SITE_PORT, '127.0.0.1', r));
  cleanups.push(() => server.close());
  const siteUrl = `http://127.0.0.1:${SITE_PORT}`;

  // 4. Browsers. Host candidates as plain addresses (no mDNS) so tabs on one machine can meet.
  const { chromium } = await import(join(root, 'node_modules/playwright-core/index.mjs'));
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'] });
  cleanups.push(() => browser.close());
  const errors = [];
  let publicTrackerSockets = 0;
  const newTab = async () => {
    const context = await browser.newContext({ bypassCSP: true, acceptDownloads: true });
    // the public WebTorrent trackers Sayl uses are this local one here
    await context.routeWebSocket(/^wss:\/\/tracker\.(openwebtorrent\.com|webtorrent\.dev|files\.fm)/, (ws) => {
      publicTrackerSockets++;
      const upstream = new WebSocket(trackerUrl);
      const waiting = [];
      upstream.onopen = () => waiting.splice(0).forEach((m) => upstream.send(m));
      upstream.onmessage = (e) => ws.send(typeof e.data === 'string' ? e.data : Buffer.from(e.data));
      upstream.onclose = () => ws.close();
      ws.onMessage((m) => (upstream.readyState === 1 ? upstream.send(m) : waiting.push(m)));
      ws.onClose(() => upstream.close());
    });
    // no public HTTP trackers to ask
    await context.route(/raw\.githubusercontent\.com\/ngosang/, (route) =>
      route.fulfill({ contentType: 'text/plain', body: [1, 2, 3, 4, 5].map((n) => `http://127.0.0.1:${n}/announce`).join('\n\n') }),
    );
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    return page;
  };
  const setUp = async (page, webrtc) => {
    await page.goto(siteUrl);
    await page.getByPlaceholder('https://sayl-relay.you.workers.dev').fill(relayUrl);
    await page.getByLabel('save relay').click();
    await page.getByLabel('add a torrent').waitFor({ timeout: 15_000 });
    // two people here share one relay (in real life each has their own): keep their lists apart
    await page.goto(`${siteUrl}/settings`);
    await page.getByRole('switch', { name: 'same list on all your devices' }).click();
    if (webrtc) await setWebrtc(page, true, '2.0');
    else await page.goto(siteUrl);
  };
  // the sharing tab serves two downloaders here, so its ratio limit is 2
  const setWebrtc = async (page, on, ratio = null) => {
    await page.goto(`${siteUrl}/settings`);
    const sw = page.getByRole('switch', { name: 'direct connections (webrtc)' });
    if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
    if (ratio) await page.getByRole('radiogroup', { name: 'ratio limit' }).getByRole('radio', { name: ratio }).click();
    await page.goto(siteUrl);
    await page.getByLabel('add a torrent').waitFor({ timeout: 15_000 });
  };
  const card = (page, name) => page.locator(`article[aria-label="${name}"]`);
  const waitPill = (page, name, text, seconds = 90) => card(page, name).locator('.pill', { hasText: new RegExp(`^${text}$`) }).waitFor({ timeout: seconds * 1000 });
  const addMagnet = async (page, magnet) => {
    await page.getByLabel('add a torrent').locator('input').fill(magnet);
    await page.getByLabel('add torrent').click();
  };
  const save = async (page, click) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), click()]);
    return readFileSync(await dl.path());
  };

  const seeder = await newTab();
  const leecher = await newTab();
  await setUp(seeder, true);
  await setUp(leecher, false);
  for (const p of [seeder, leecher]) await p.getByRole('switch', { name: 'select files' }).click(); // start every file at once

  // 5. Sayl shares a folder with WebRTC on: the magnet names the WebTorrent trackers.
  const shareDir = join(work, 'rtcshare');
  mkdirSync(join(shareDir, 'sub'), { recursive: true });
  const a = randomBytes(3 * 1024 * 1024 + 11);
  const b = randomBytes(7000);
  writeFileSync(join(shareDir, 'a.bin'), a);
  writeFileSync(join(shareDir, 'sub', 'b.txt'), b);
  await seeder.locator('input[webkitdirectory]').setInputFiles(shareDir);
  await seeder.getByRole('dialog').getByRole('button', { name: 'make torrent' }).click();
  await seeder.getByRole('dialog').getByText('seeding from this tab now').waitFor({ timeout: 60_000 });
  const magnet = await seeder.getByRole('dialog').locator('#share-magnet').inputValue();
  await seeder.getByRole('dialog').getByRole('button', { name: 'done' }).click();
  check('with webrtc on, a shared torrent\'s magnet names the webtorrent trackers', magnet.includes(encodeURIComponent('wss://tracker.openwebtorrent.com')));
  await until(async () => publicTrackerSockets > 0 && trackerSockets.size > 0, 20, 'the seeder to reach the tracker');

  // 6. Another tab with WebRTC off gets nowhere: nothing goes direct unless it's turned on.
  const before = publicTrackerSockets;
  await addMagnet(leecher, magnet);
  await new Promise((r) => setTimeout(r, 12_000));
  check('with webrtc off (the default), a tab never contacts the webtorrent trackers', publicTrackerSockets === before && (await card(leecher, 'rtcshare').locator('.pill').textContent()) === 'finding files');

  // 7. Turned on, the second tab gets the metadata and files straight from the first.
  await setWebrtc(leecher, true);
  await waitPill(leecher, 'rtcshare', 'done', 120).catch(() => {});
  const got = (await card(leecher, 'rtcshare').locator('.pill').textContent()) === 'done';
  let savedA = Buffer.alloc(0);
  if (got) {
    await card(leecher, 'rtcshare').getByLabel('download', { exact: true }).click();
    savedA = await save(leecher, () => leecher.getByRole('dialog').getByLabel('download a.bin').click());
    await leecher.getByRole('dialog').getByLabel('close').click();
  }
  check('with webrtc on, one sayl tab downloads a shared folder from another, directly, intact', got && sha256(savedA) === sha256(a));
  const seederFoot = await card(seeder, 'rtcshare').locator('.foot').textContent();
  check('the sharing tab counts the upload, and keeps seeding below its ratio limit', /uploaded [1-9]/.test(seederFoot ?? '') && (await card(seeder, 'rtcshare').locator('.pill').textContent()) === 'seeding', seederFoot?.replace(/\s+/g, ' '));

  // 8. The WebTorrent client itself downloads it from Sayl.
  const wt = await newTab();
  await wt.goto(`${siteUrl}/wt.html`);
  await wt.waitForFunction(() => window.ready === true, null, { timeout: 15_000 });
  const fromSayl = await wt.evaluate(
    async ({ magnet, trackerUrl }) => {
      const client = new window.WebTorrent();
      window.client = client;
      return await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: 'timed out' }), 90_000);
        client.add(magnet, { announce: [trackerUrl] }, (torrent) => {
          const finish = async () => {
            clearTimeout(timer);
            const f = torrent.files.find((x) => x.name === 'a.bin');
            const buf = new Uint8Array(await f.arrayBuffer());
            const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (x) => x.toString(16).padStart(2, '0')).join('');
            resolve({ sha: digest, files: torrent.files.map((x) => x.path) });
          };
          if (torrent.done) finish();
          else torrent.on('done', finish);
        });
      });
    },
    { magnet, trackerUrl },
  );
  check('the webtorrent client downloads from sayl (metadata included), intact', fromSayl.sha === sha256(a), JSON.stringify(fromSayl).slice(0, 120));

  // 9. And Sayl downloads from a WebTorrent seeder.
  const c = randomBytes(2 * 1024 * 1024 + 5);
  const wtMagnet = await wt.evaluate(
    ({ bytes, trackerUrl }) =>
      new Promise((resolve) => {
        const file = new File([new Uint8Array(bytes)], 'from-webtorrent.bin');
        window.client.seed(file, { announce: [trackerUrl] }, (torrent) => resolve(torrent.magnetURI));
      }),
    { bytes: [...c], trackerUrl },
  );
  await addMagnet(leecher, wtMagnet);
  await waitPill(leecher, 'from-webtorrent.bin', 'done', 120).catch(() => {});
  let savedC = Buffer.alloc(0);
  if ((await card(leecher, 'from-webtorrent.bin').locator('.pill').textContent()) === 'done') {
    savedC = await save(leecher, () => card(leecher, 'from-webtorrent.bin').getByLabel('download', { exact: true }).click());
  }
  check('sayl downloads from a webtorrent seeder, intact', sha256(savedC) === sha256(c));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check(`unexpected error: ${err.message.split('\n')[0]}`, false);
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
    await new Promise((r) => setTimeout(r, 300));
  }
}
