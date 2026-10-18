#!/usr/bin/env node
/**
 * End-to-end test of the Sayl website in browser mode, on one machine:
 *   a real qBittorrent (Docker) seeds a multi-file and a single-file torrent,
 *   a fake HTTP tracker points at it, `wrangler dev` runs the relay,
 *   the website is built with ENGINE=browser and opened in Chromium,
 *   and a script clicks through it like a person: set the relay, add torrents,
 *   pick files, download, save, recheck, reload mid-download, remove, and share:
 *   make a torrent from a folder, which qBittorrent then downloads from the page.
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
  for (const f of files) if (f.bytes) f.size = f.bytes.length;
  const blobs = files.map((f) => f.bytes ?? randomBytes(f.size));
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
  // a real video (VP8 in WebM, which Chromium plays) to watch while it downloads
  const clipPath = join(work, 'clip.webm');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=20:size=320x240:rate=25', '-c:v', 'libvpx', '-b:v', '600k', '-g', '25', clipPath]);
  const movie = makeTorrent(downloads, 'movie', [
    { path: 'notes.txt', size: 2000 },
    { path: 'clip.webm', bytes: readFileSync(clipPath) },
  ]);

  // 2. Fake tracker.
  const tracker = createServer((req, res) => res.end(Buffer.from(encode({ interval: 60, peers: new Uint8Array([127, 0, 0, 1, QBIT_PORT >> 8, QBIT_PORT & 255]) }))));
  await new Promise((r) => tracker.listen(0, '127.0.0.1', r));
  cleanups.push(() => tracker.close());
  const trackerUrl = `http://127.0.0.1:${tracker.address().port}/announce`;
  const torrents = {};
  for (const [key, t] of Object.entries({ pack, single, big, movie })) {
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
  // qBittorrent only keeps a few torrents active by default and queues the rest
  await fetch(`${qbit}/api/v2/app/setPreferences`, { method: 'POST', body: new URLSearchParams({ json: JSON.stringify({ queueing_enabled: false }) }), headers: { cookie } });
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
    return list.length === Object.keys(torrents).length && list.every((t) => t.progress === 1 && /UP$/.test(t.state) && t.state !== 'queuedUP');
  }, 120, 'qbittorrent seeding');
  check('qbittorrent is seeding the test torrents', true);

  // 4. The relay.
  const wrangler = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--persist-to', join(work, 'relay-state'), '--var', 'ALLOW_PRIVATE_TARGETS:1'], {
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
  // The public tracker list the page fetches: here, the fake tracker (and a few that don't answer).
  await context.route(/raw\.githubusercontent\.com\/ngosang/, (route) =>
    route.fulfill({ contentType: 'text/plain', body: [trackerUrl, ...[1, 2, 3, 4].map((n) => `http://127.0.0.1:${n}/announce`)].join('\n\n') }),
  );
  // the screen wake lock, recorded (a headless browser has no screen to keep on)
  await context.addInitScript(() => {
    window.__wake = { requests: 0, releases: 0 };
    Object.defineProperty(navigator, 'wakeLock', {
      value: {
        request: async () => {
          window.__wake.requests++;
          const lock = { released: false, release: async () => ((lock.released = true), window.__wake.releases++) };
          return lock;
        },
      },
    });
  });
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

  // 6b2. The whole torrent at once: as a .zip, and into a folder (the folder picker is swapped for a folder in OPFS).
  await page.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('picked', { create: true });
  });
  await card('pack').getByLabel('download', { exact: true }).click();
  const zipped = await save(() => page.getByRole('dialog').getByRole('button', { name: 'download .zip' }).click());
  const zipPath = join(work, 'pack.zip');
  writeFileSync(zipPath, zipped.bytes);
  const inZip = JSON.parse(
    execFileSync('python3', ['-I', '-c', 'import zipfile,sys,hashlib,json\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()}))', zipPath]).toString(),
  );
  check(
    'download .zip: one zip of the finished files, in the torrent\'s folder, intact',
    zipped.name === 'pack.zip' && JSON.stringify(inZip) === JSON.stringify({ 'pack/a.bin': sha256(pack.blobs[0]), 'pack/c.txt': sha256(pack.blobs[2]) }),
    JSON.stringify(Object.keys(inZip)),
  );
  await page.getByRole('dialog').getByRole('button', { name: 'save to a folder' }).click();
  await page.getByText('saved 2 files').waitFor({ timeout: 30_000 });
  const inFolder = await page.evaluate(async () => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('picked')).getDirectoryHandle('pack');
    const out = {};
    for (const name of ['a.bin', 'c.txt']) {
      const bytes = await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
      out[name] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    return out;
  });
  check('save to a folder: the files land in a folder named after the torrent, intact', inFolder['a.bin'] === sha256(pack.blobs[0]) && inFolder['c.txt'] === sha256(pack.blobs[2]));
  await page.getByRole('dialog').getByLabel('close').click();

  // 6c. Single-file .torrent, with "select files" off: starts by itself.
  await page.getByRole('switch', { name: 'select files' }).click();
  await page.locator('input[type=file][accept]').setInputFiles(join(work, 'single.torrent'));
  await waitPill('single.bin', 'done');
  const savedS = await save(() => card('single.bin').getByLabel('download', { exact: true }).click());
  check('a dropped .torrent starts on its own and saves intact', savedS.name === 'single.bin' && sha256(savedS.bytes) === sha256(single.blobs[0]));

  // 6c2. Playing a video while it downloads: the player streams it through the service worker.
  await addMagnet(torrents.movie.magnet);
  await card('movie').getByLabel('play').waitFor({ timeout: 60_000 });
  const ranged = await page.evaluate(async (hash) => {
    const res = await fetch(`/stream/${hash}/1/clip.webm`, { headers: { range: 'bytes=100-199' } });
    return { status: res.status, range: res.headers.get('content-range'), type: res.headers.get('content-type'), bytes: Array.from(new Uint8Array(await res.arrayBuffer())) };
  }, torrents.movie.hash);
  check(
    'the stream answers byte ranges of the file being downloaded',
    ranged.status === 206 && ranged.range === `bytes 100-199/${movie.blobs[1].length}` && ranged.type === 'video/webm' && Buffer.from(ranged.bytes).equals(movie.blobs[1].subarray(100, 200)),
    `${ranged.status} ${ranged.range}`,
  );
  await card('movie').getByLabel('play').click();
  const video = page.getByRole('dialog').locator('video');
  await video.waitFor({ timeout: 15_000 });
  const played = await video.evaluate(async (v) => {
    v.muted = true;
    await v.play().catch(() => {});
    const wait = (ok, ms) => new Promise((resolve) => {
      const end = Date.now() + ms;
      const tick = () => (ok() ? resolve(true) : Date.now() > end ? resolve(false) : setTimeout(tick, 100));
      tick();
    });
    const playing = await wait(() => v.currentTime > 1, 20_000);
    const duration = v.duration;
    v.currentTime = duration - 2; // skip near the end: those bytes are fetched on demand
    const seeked = await wait(() => !v.seeking && v.readyState >= 2 && v.currentTime >= duration - 2.5, 20_000);
    return { playing, seeked, duration, error: v.error?.message ?? null };
  });
  await shot('player');
  check('a video plays in the page while it downloads, and skipping ahead works', played.playing && played.seeked && Math.abs(played.duration - 20) < 1, JSON.stringify(played));
  await page.getByRole('dialog').getByRole('button', { name: 'done' }).click();

  // 6c3. Installable: the manifest and its icons.
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.getAttribute('href');
    const m = await (await fetch(href)).json();
    const icons = await Promise.all(m.icons.map(async (i) => (await fetch(i.src)).headers.get('content-type')));
    return { name: m.name, display: m.display, start: m.start_url, icons, purposes: m.icons.map((i) => i.purpose ?? 'any') };
  });
  check(
    'the site is installable: a manifest with app icons (one maskable)',
    manifest.name === 'Sayl' && manifest.display === 'standalone' && manifest.start === '/' && manifest.icons.every((t) => t === 'image/png') && manifest.purposes.includes('maskable'),
    JSON.stringify(manifest),
  );

  // 6c4. "Keep the screen on while downloading" (on by default on phones; turned on here).
  await page.goto(`${siteUrl}/settings`);
  const awake = page.getByRole('switch', { name: 'keep the screen on while downloading' });
  check('on a computer, keeping the screen on is off by default', (await awake.getAttribute('aria-checked')) === 'false');
  await awake.click();
  const phone = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  const phonePage = await phone.newPage();
  await phonePage.goto(`${siteUrl}/settings`);
  check(
    'on a phone, keeping the screen on is on by default',
    (await phonePage.getByRole('switch', { name: 'keep the screen on while downloading' }).getAttribute('aria-checked')) === 'true',
  );
  await phone.close();
  await page.goto(siteUrl);
  await page.getByLabel('add a torrent').waitFor({ timeout: 15_000 });

  // 6d. Reload in the middle of a download: it picks up where it left off.
  await addMagnet(torrents.big.magnet);
  let atReload = 0;
  await until(async () => {
    atReload = Number(await card('big.bin').getByRole('progressbar').getAttribute('aria-valuenow'));
    return atReload >= 10;
  }, 120, 'the big download to get going');
  // details, live, and "report a problem" without anything that says what's downloading
  await card('big.bin').getByLabel('details for big.bin').click();
  const details = page.getByRole('dialog');
  await details.getByText('1 peers').waitFor({ timeout: 15_000 });
  const detailText = (await details.textContent()) ?? '';
  check('details show the running torrent: peers, pieces, trackers', /running/.test(detailText) && /1 connected/.test(detailText) && detailText.includes(trackerUrl), detailText.replace(/\s+/g, ' ').slice(0, 160));
  const report = new URL((await details.getByRole('link', { name: 'report a problem' }).getAttribute('href')) ?? 'x:');
  const reportBody = report.searchParams.get('body') ?? '';
  check(
    'report a problem: a github issue with the technical state, and no name, hash or tracker address',
    report.href.startsWith('https://github.com/kitakitaaura/sayl/issues/new') &&
      /browser: /.test(reportBody) &&
      /relay: version/.test(reportBody) &&
      /peers: \d+ connected/.test(reportBody) &&
      !reportBody.includes('big.bin') &&
      !reportBody.includes(torrents.big.hash) &&
      !reportBody.includes('127.0.0.1'),
    reportBody.split('\n').slice(6, 9).join(' / '),
  );
  await details.getByRole('button', { name: 'done' }).click();
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
  const wake = await page.evaluate(() => window.__wake);
  check('the screen is kept on while downloading, and let go once done', wake.requests >= 1 && wake.releases >= 1, JSON.stringify(wake));
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

  // 6g. Sharing a folder: Sayl makes the torrent and seeds it; qBittorrent downloads it from the page.
  const shareDir = join(work, 'myshare');
  mkdirSync(join(shareDir, 'sub'), { recursive: true });
  const shareA = randomBytes(2 * 1024 * 1024 + 3);
  const shareB = randomBytes(5000);
  writeFileSync(join(shareDir, 'a.bin'), shareA);
  writeFileSync(join(shareDir, 'sub', 'b.txt'), shareB);
  await page.locator('input[webkitdirectory]').setInputFiles(shareDir);
  const shareDialog = page.getByRole('dialog');
  await shareDialog.getByLabel('name', { exact: true }).waitFor({ timeout: 10_000 });
  check('picking a folder offers to share it, named after the folder', (await shareDialog.getByLabel('name', { exact: true }).inputValue()) === 'myshare');
  await shareDialog.getByRole('button', { name: 'make torrent' }).click();
  await shareDialog.getByText('seeding from this tab now').waitFor({ timeout: 60_000 });
  await shot('shared');
  const magnet = await shareDialog.locator('#share-magnet').inputValue();
  const savedTorrent = await save(() => shareDialog.getByRole('button', { name: 'save .torrent file' }).click());
  const madeTorrent = await parseTorrentFile(new Uint8Array(savedTorrent.bytes));
  check(
    'it gives a magnet link and a matching .torrent',
    magnet.includes(`xt=urn:btih:${madeTorrent.infoHash}`) && savedTorrent.name === 'myshare.torrent' && madeTorrent.trackers.includes(trackerUrl),
    magnet.slice(0, 70),
  );
  await shareDialog.getByRole('button', { name: 'done' }).click();
  await waitPill('myshare', 'seeding', 10);
  check('the new torrent is in the list, seeding', true);
  const qAdd = await fetch(`${qbit}/api/v2/torrents/add`, { method: 'POST', body: new URLSearchParams({ urls: magnet, savepath: '/downloads/fromsayl' }), headers: { cookie } });
  let qt = null;
  await until(async () => {
    qt = (await (await fetch(`${qbit}/api/v2/torrents/info?hashes=${madeTorrent.infoHash}`, { headers: { cookie } })).json())[0];
    return qt?.progress === 1;
  }, 120, 'qbittorrent to download from the page').catch(() => {});
  const fromPage = (...p) => {
    try {
      return readFileSync(join(downloads, 'fromsayl', 'myshare', ...p));
    } catch {
      return Buffer.alloc(0);
    }
  };
  check('qbittorrent downloads the shared folder from the page, intact', qAdd.ok && qt?.progress === 1 && fromPage('a.bin').equals(shareA) && fromPage('sub', 'b.txt').equals(shareB), qt?.state);
  await waitPill('myshare', 'done', 60).catch(() => {});
  const shareSub = await card('myshare').locator('.foot').textContent();
  check('seeding stops by itself at the ratio limit (1.0)', (await pill('myshare').textContent()) === 'done' && /ratio (1|2)\.\d\d/.test(shareSub ?? ''), shareSub?.replace(/\s+/g, ' '));

  // 6h. Seeding a finished download is opt-in, per torrent; the share dialog has its magnet.
  check('a finished download does not seed unless asked', (await pill('single.bin').textContent()) === 'done');
  await card('single.bin').getByLabel('seed', { exact: true }).click();
  await waitPill('single.bin', 'seeding', 10);
  await card('single.bin').getByLabel('stop seeding').click();
  await waitPill('single.bin', 'done', 10);
  check('the seed button starts and stops seeding', true);
  await card('single.bin').getByLabel('share').click();
  const singleMagnet = await page.getByRole('dialog').locator('#share-magnet').inputValue();
  check('the share dialog gives a torrent\'s magnet', singleMagnet.includes(torrents.single.hash), singleMagnet.slice(0, 60));
  await page.getByRole('dialog').getByRole('button', { name: 'done' }).click();

  // 6h2. The same list on another device: another browser profile on the same relay.
  const other = await browser.newContext({ bypassCSP: true, acceptDownloads: true });
  const pageB = await other.newPage();
  pageB.on('pageerror', (e) => errors.push(`other device: ${e.message}`));
  const cardB = (name) => pageB.locator(`article[aria-label="${name}"]`);
  await pageB.goto(siteUrl);
  await pageB.getByPlaceholder('https://sayl-relay.you.workers.dev').fill(relayUrl);
  await pageB.getByLabel('save relay').click();
  await pageB.getByLabel('add a torrent').waitFor({ timeout: 15_000 });
  await until(async () => (await cardB('pack').count()) > 0, 30, 'the list to reach the other device');
  check(
    'another device on the same relay gets the list, paused until resumed there',
    (await cardB('pack').locator('.pill').textContent()) === 'paused' && (await cardB('pack').getByText('added on another device').count()) === 1,
  );
  const ghostHash = randomBytes(20).toString('hex');
  await addMagnet(`magnet:?xt=urn:btih:${ghostHash}&dn=ghost`);
  await card('ghost').waitFor({ timeout: 10_000 });
  await until(async () => {
    await pageB.reload();
    // it syncs a second after loading
    return cardB('ghost').waitFor({ timeout: 5000 }).then(() => true, () => false);
  }, 40, 'a new torrent to reach the other device');
  await card('ghost').getByLabel('remove').click();
  await page.getByRole('dialog').getByRole('button', { name: 'delete files' }).click();
  await until(async () => {
    await pageB.reload();
    return cardB('ghost').waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false);
  }, 40, 'a removal to reach the other device');
  check('removed on one device, a torrent with nothing downloaded goes on the other too', true);
  await cardB('single.bin').getByLabel('resume').click();
  // like any magnet: the file list arrives, then you pick what to download
  await cardB('single.bin').getByLabel('choose files').click({ timeout: 60_000 });
  await pageB.getByRole('button', { name: 'download selected' }).click();
  await cardB('single.bin').locator('.pill', { hasText: /^done$/ }).waitFor({ timeout: 60_000 });
  await card('single.bin').getByLabel('remove').click();
  await page.getByRole('dialog').getByRole('button', { name: 'delete files' }).click();
  await new Promise((r) => setTimeout(r, 3500)); // the removal goes out
  await pageB.reload();
  await pageB.getByLabel('add a torrent').waitFor({ timeout: 15_000 });
  await new Promise((r) => setTimeout(r, 3000)); // and the other device syncs
  check('but a torrent with files on the other device stays there', (await cardB('single.bin').locator('.pill').textContent()) === 'done');
  await other.close();

  // 6i. Settings show the relay and storage.
  await page.goto(`${siteUrl}/settings`);
  await page.getByText('using').waitFor({ timeout: 10_000 });
  await shot('settings');
  check('settings show the relay in use', (await page.getByText(relayUrl).count()) > 0);
  check('settings show browser storage', (await page.getByText('browser storage').count()) > 0);
  const meter = (await page.getByRole('meter', { name: 'relay requests today' }).locator('..').textContent()) ?? '';
  const used = Number(/([\d,]+) of 100,000/.exec(meter)?.[1]?.replace(/,/g, '') ?? 0);
  check('settings estimate today\'s relay use against the free allowance', used > 10, meter.replace(/\s+/g, ' '));
  await page.evaluate(() => localStorage.setItem('sayl.usage', JSON.stringify({ day: new Date().toISOString().slice(0, 10), workerRequests: 85_000, doRequests: 1000, doSeconds: 100 })));
  await page.goto(siteUrl);
  await page.getByText("of your relay's free daily allowance").waitFor({ timeout: 15_000 });
  check('near the free allowance, the home page warns', (await page.getByText('about 85%').count()) === 1);
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
