#!/usr/bin/env node
/**
 * End-to-end test of the Sayl website in browser mode, on one machine:
 *   a real qBittorrent (Docker) seeds a multi-file and a single-file torrent,
 *   a fake HTTP tracker points at it, `wrangler dev` runs the relay,
 *   the website is built with ENGINE=browser and opened in Chromium,
 *   and a script clicks through it like a person: set the relay, add torrents,
 *   pick files, download, save, recheck, reload mid-download, remove.
 * Every saved file is compared byte for byte with the original.
 *
 * Needs Docker, linuxserver/qbittorrent:5.2.4, and playwright-core
 * (npm install --no-save playwright-core@1.56.1).
 *   node test/website.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode } from '../../client/bencode.js';
import { parseTorrentFile } from '../../client/torrent.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const frontend = join(root, '../frontend');
const QBIT_PORT = 16881;
const WEBUI_PORT = 18080;
const RELAY_PORT = 18787;
const SITE_PORT = 18173;
const CONTAINER = 'sayl-website-test-qbit';
const PIECE = 256 * 1024;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const work = mkdtempSync(join(tmpdir(), 'sayl-website-'));
const cleanups = [];
const cleanup = () => {
  for (const c of cleanups.reverse()) {
    try {
      c();
    } catch {}
  }
};

/** Writes the files under downloads/ and returns a .torrent for them. */
function makeTorrent(downloads, name, files) {
  const blobs = files.map((f) => randomBytes(f.size));
  if (files.length === 1 && !files[0].path.includes('/')) {
    writeFileSync(join(downloads, name), blobs[0]);
  } else {
    for (const [i, f] of files.entries()) {
      const p = join(downloads, name, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, blobs[i]);
    }
  }
  const all = Buffer.concat(blobs);
  const hashes = [];
  for (let o = 0; o < all.length; o += PIECE) hashes.push(createHash('sha1').update(all.subarray(o, o + PIECE)).digest());
  const info =
    files.length === 1 && !files[0].path.includes('/')
      ? { name, length: all.length, 'piece length': PIECE, pieces: new Uint8Array(Buffer.concat(hashes)) }
      : { name, 'piece length': PIECE, pieces: new Uint8Array(Buffer.concat(hashes)), files: files.map((f) => ({ length: f.size, path: f.path.split('/') })) };
  return { blobs, info };
}

try {
  // 1. Content.
  const downloads = join(work, 'downloads');
  mkdirSync(downloads);
  const pack = makeTorrent(downloads, 'pack', [
    { path: 'a.bin', size: 3 * 1024 * 1024 + 123 },
    { path: 'sub/b.bin', size: 5 * 1024 * 1024 + 7 },
    { path: 'c.txt', size: 1000 },
  ]);
  const single = makeTorrent(downloads, 'single.bin', [{ path: 'single.bin', size: 6 * 1024 * 1024 + 99 }]);
  const big = makeTorrent(downloads, 'big.bin', [{ path: 'big.bin', size: 120 * 1024 * 1024 + 5 }]);

  // 2. Fake tracker.
  const tracker = createServer((req, res) => res.end(Buffer.from(encode({ interval: 60, peers: new Uint8Array([127, 0, 0, 1, QBIT_PORT >> 8, QBIT_PORT & 255]) }))));
  await new Promise((r) => tracker.listen(0, '127.0.0.1', r));
  cleanups.push(() => tracker.close());
  const trackerUrl = `http://127.0.0.1:${tracker.address().port}/announce`;
  const torrents = {};
  for (const [key, t] of Object.entries({ pack, single, big })) {
    const bytes = encode({ announce: trackerUrl, info: t.info });
    const parsed = await parseTorrentFile(bytes);
    torrents[key] = { ...t, bytes, hash: parsed.infoHash, magnet: `magnet:?xt=urn:btih:${parsed.infoHash}&dn=${t.info.name}&tr=${encodeURIComponent(trackerUrl)}` };
    writeFileSync(join(work, `${key}.torrent`), bytes);
  }

  // 3. qBittorrent seeding all three.
  const config = join(work, 'config');
  const password = randomBytes(12).toString('hex');
  execFileSync('node', [join(root, '../deploy/qbit-init/init.mjs')], {
    env: { ...process.env, QBIT_USERNAME: 'admin', QBIT_PASSWORD: password, TORRENT_PORT: String(QBIT_PORT), QBIT_CONFIG_DIR: join(config, 'qBittorrent') },
    stdio: 'ignore',
  });
  execFileSync('chmod', ['-R', 'a+rwX', work]);
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
    return (r.status === 204 || r.status === 200) && cookie;
  }, 60, 'qbittorrent');
  for (const t of Object.values(torrents)) {
    const form = new FormData();
    form.append('torrents', new Blob([t.bytes]), 'x.torrent');
    form.append('savepath', '/downloads');
    form.append('contentLayout', 'Original');
    const r = await fetch(`${qbit}/api/v2/torrents/add`, { method: 'POST', body: form, headers: { cookie } });
    if (!r.ok) throw new Error(`qbittorrent refused a torrent: ${r.status}`);
  }
  await until(async () => {
    const list = await (await fetch(`${qbit}/api/v2/torrents/info`, { headers: { cookie } })).json();
    return list.length === 3 && list.every((t) => t.progress === 1 && /UP$/.test(t.state));
  }, 120, 'qbittorrent seeding');
  check('qbittorrent is seeding the test torrents', true);

  // 4. The relay.
  const wrangler = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--var', 'ALLOW_PRIVATE_TARGETS:1'], {
    cwd: root,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    stdio: 'ignore',
  });
  cleanups.push(() => wrangler.kill('SIGTERM'));
  const relayUrl = `http://127.0.0.1:${RELAY_PORT}`;
  await until(async () => (await fetch(`${relayUrl}/health`)).ok, 60, 'wrangler dev');

  // 5. The website, built in browser mode and served as static files.
  execFileSync('npm', ['run', 'build'], { cwd: frontend, env: { ...process.env, ENGINE: 'browser', API_URL: '' }, stdio: 'ignore' });
  const site = join(frontend, 'build');
  const csp = /connect-src ([^;"]*)/.exec(readFileSync(join(site, 'index.html'), 'utf8'))?.[1];
  check('the browser build may reach any https/wss relay', csp === "'self' https: wss:", csp);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };
  const server = createServer((req, res) => {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
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

  // 6. A person using it.
  const { chromium } = await import(join(root, 'node_modules/playwright-core/index.mjs'));
  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  // The relay here is plain http/ws on localhost, which the page's https/wss policy rightly blocks; the policy itself is checked above.
  const context = await browser.newContext({ bypassCSP: true, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  const shots = process.env.SCREENSHOTS;
  const shot = async (name) => shots && (await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }));
  await page.goto(siteUrl);
  await page.getByPlaceholder('https://sayl-relay.you.workers.dev').waitFor({ timeout: 15_000 });
  await shot('setup');
  check('a first visit asks for a relay', true);
  await page.getByPlaceholder('https://sayl-relay.you.workers.dev').fill(relayUrl);
  await page.getByLabel('save relay').click();
  await page.getByLabel('add a torrent').waitFor({ timeout: 15_000 });
  check('saving a working relay shows the omnibox', true);

  const card = (name) => page.locator(`article[aria-label="${name}"]`);
  const pill = (name) => card(name).locator('.pill');
  const waitPill = (name, text, seconds = 120) => card(name).locator('.pill', { hasText: new RegExp(`^${text}$`) }).waitFor({ timeout: seconds * 1000 });
  const addMagnet = async (magnet) => {
    await page.getByLabel('add a torrent').locator('input').fill(magnet);
    await page.getByLabel('add torrent').click();
  };
  const save = async (click) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), click()]);
    return { name: dl.suggestedFilename(), bytes: readFileSync(await dl.path()) };
  };

  // 6a. Multi-file magnet: pick two of three files.
  await addMagnet(torrents.pack.magnet);
  await page.getByRole('dialog').getByText('c.txt').waitFor({ timeout: 60_000 });
  await shot('files');
  check('a magnet gets its file list from the peer', true);
  await page.getByRole('dialog').locator('label', { hasText: 'b.bin' }).locator('input').uncheck();
  await page.getByRole('button', { name: 'download selected' }).click();
  await waitPill('pack', 'done');
  await shot('done');
  check('two of three files download', true, await card('pack').locator('.sub').textContent());
  await card('pack').getByLabel('download', { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('download a.bin').waitFor();
  const savedA = await save(() => dialog.getByLabel('download a.bin').click());
  const savedC = await save(() => dialog.getByLabel('download c.txt').click());
  check(
    'saved files match the originals',
    savedA.name === 'a.bin' && sha256(savedA.bytes) === sha256(pack.blobs[0]) && savedC.name === 'c.txt' && sha256(savedC.bytes) === sha256(pack.blobs[2]),
    `${savedA.name} ${savedA.bytes.length} B, ${savedC.name} ${savedC.bytes.length} B`,
  );
  check('the skipped file is not offered', (await dialog.getByLabel('download b.bin').count()) === 0);
  await dialog.getByLabel('close').click();

  // 6b. Recheck re-reads everything from storage, including pieces shared with the skipped file.
  await card('pack').getByLabel('force recheck').click();
  await waitPill('pack', 'done', 60);
  check('a recheck finds every piece intact', (await card('pack').getByRole('progressbar').getAttribute('aria-valuenow')) === '100');

  // 6c. Single-file .torrent, with "select files" off: starts by itself.
  await page.getByRole('switch', { name: 'select files' }).click();
  await page.locator('input[type=file]').setInputFiles(join(work, 'single.torrent'));
  await waitPill('single.bin', 'done');
  const savedS = await save(() => card('single.bin').getByLabel('download', { exact: true }).click());
  check('a dropped .torrent starts on its own and saves intact', savedS.name === 'single.bin' && sha256(savedS.bytes) === sha256(single.blobs[0]));

  // 6d. Reload in the middle of a download: it picks up where it left off.
  await addMagnet(torrents.big.magnet);
  let atReload = 0;
  await until(async () => {
    atReload = Number(await card('big.bin').getByRole('progressbar').getAttribute('aria-valuenow'));
    return atReload >= 10;
  }, 120, 'the big download to get going');
  // pause holds still, resume carries on
  await card('big.bin').getByLabel('pause').click();
  await waitPill('big.bin', 'paused', 10);
  const pausedAt = await card('big.bin').getByRole('progressbar').getAttribute('aria-valuenow');
  await new Promise((r) => setTimeout(r, 2500));
  const stillAt = await card('big.bin').getByRole('progressbar').getAttribute('aria-valuenow');
  await shot('paused');
  await card('big.bin').getByLabel('resume').click();
  await until(async () => Number(await card('big.bin').getByRole('progressbar').getAttribute('aria-valuenow')) > Number(stillAt) + 2, 60, 'progress after resuming');
  check('pause holds still and resume carries on', pausedAt === stillAt, `paused at ${pausedAt}%`);
  atReload = Number(await card('big.bin').getByRole('progressbar').getAttribute('aria-valuenow'));
  await page.reload();
  const afterReload = Number(await card('big.bin').getByRole('progressbar').getAttribute('aria-valuenow', { timeout: 15_000 }));
  check('progress survives a reload', afterReload >= atReload - 1 && afterReload < 100, `${atReload}% before, ${afterReload}% after`);
  await waitPill('big.bin', 'done', 180);
  const savedB = await save(() => card('big.bin').getByLabel('download', { exact: true }).click());
  check('the resumed download saves intact', sha256(savedB.bytes) === sha256(big.blobs[0]), `${savedB.bytes.length} bytes`);

  // 6e. The list and finished files survive a reload.
  await page.reload();
  await waitPill('pack', 'done', 15);
  const again = await save(async () => {
    await card('pack').getByLabel('download', { exact: true }).click();
    await page.getByRole('dialog').getByLabel('download a.bin').click();
  });
  check('finished files can be saved again after a reload', sha256(again.bytes) === sha256(pack.blobs[0]));
  await page.getByRole('dialog').getByLabel('close').click();

  // 6f. Removing frees the storage.
  await card('big.bin').getByLabel('remove').click();
  await page.getByRole('dialog').getByRole('button', { name: 'delete files' }).click();
  await card('big.bin').waitFor({ state: 'detached', timeout: 10_000 });
  const left = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sayl');
    const names = [];
    for await (const name of dir.keys()) names.push(name);
    return names;
  });
  check('removing a torrent deletes its stored files', !left.includes(torrents.big.hash) && left.includes(torrents.pack.hash), left.join(', '));

  // 6g. Settings show the relay and storage.
  await page.goto(`${siteUrl}/settings`);
  await page.getByText('using').waitFor({ timeout: 10_000 });
  await shot('settings');
  check('settings show the relay in use', (await page.getByText(relayUrl).count()) > 0);
  check('settings show browser storage', (await page.getByText('browser storage').count()) > 0);
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
    await new Promise((r) => setTimeout(r, 500));
  }
}
