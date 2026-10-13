#!/usr/bin/env node
/**
 * End-to-end smoke test against a running Sayl, through its public API and
 * download domain. Needs Node.js 22, nothing else.
 *
 *   node scripts/smoke.mjs https://sayl-api.kitaaura.com
 *
 * By default it adds the current Debian netinst ISO (an official, legal
 * .torrent), waits for the server to download it from real peers, checks the
 * download link, then removes it.
 *
 * Options:
 *   --source <magnet|url>   add this instead of the Debian ISO
 *   --file <path.torrent>   upload this .torrent instead
 *   --code <code>           the ACCESS_CODE, if the beta gate is on
 *   --cookie <sayl_sid=…>   reuse a browser session (needed if the captcha is on)
 *   --full                  download the whole file and check its SHA-256
 *   --keep                  leave the torrent on the server afterwards
 *   --timeout <minutes>     give up after this long (default 45)
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const DEBIAN = 'https://cdimage.debian.org/debian-cd/current/amd64/';

function parseArgs(argv) {
  const out = { api: '', source: '', file: '', code: '', cookie: '', full: false, keep: false, timeout: 45 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--source') out.source = next();
    else if (a === '--file') out.file = next();
    else if (a === '--code') out.code = next();
    else if (a === '--cookie') out.cookie = next();
    else if (a === '--timeout') out.timeout = Number(next());
    else if (a === '--full') out.full = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('--') && !out.api) out.api = a.replace(/\/+$/, '');
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

const started = Date.now();
const t = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s`;
const ok = (msg) => console.log(`${t()}  ok    ${msg}`);
const info = (msg) => console.log(`${t()}  ...   ${msg}`);
class Fail extends Error {}
const fail = (msg) => {
  throw new Fail(msg);
};
const fmt = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.api) {
    console.log((await readFile(new URL(import.meta.url), 'utf8')).split('*/')[0].replace(/^#!.*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
    return opts.help ? 0 : 1;
  }

  let cookie = opts.cookie;
  async function call(method, path, body) {
    const isForm = body instanceof FormData;
    const res = await fetch(opts.api + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('sayl_sid='));
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not json
    }
    return { status: res.status, json, text };
  }

  // 1. the API answers through the tunnel
  const health = await call('GET', '/api/health');
  if (health.status !== 200 || health.json?.status !== 'ok') fail(`health check answered ${health.status}: ${health.text.slice(0, 200)}`);
  ok(`api is up (${health.json.app})`);

  // 2. a session
  const s = await call('GET', '/api/session');
  if (!s.json?.session) {
    if (s.json?.access?.captcha) {
      fail('the captcha is on. open the site in a browser, then copy the sayl_sid cookie (dev tools → application → cookies) and pass it with --cookie "sayl_sid=…"');
    }
    if (s.json?.access?.code && !opts.code) fail('the access code is on. pass it with --code');
    const r = await call('POST', '/api/session', opts.code ? { accessCode: opts.code } : undefined);
    if (r.status !== 201 || !cookie) fail(`couldn't start a session: ${r.status} ${r.json?.message ?? r.text.slice(0, 200)}`);
  }
  ok('session started');

  // 3. add a torrent
  let expectSha = null;
  let added;
  if (opts.file) {
    const form = new FormData();
    form.append('torrent', new Blob([await readFile(opts.file)]), basename(opts.file));
    added = await call('POST', '/api/torrents', form);
  } else {
    let source = opts.source;
    if (!source) {
      info('finding the current debian netinst iso');
      const listing = await (await fetch(`${DEBIAN}bt-cd/`)).text();
      const name = /href="(debian-[\d.]+-amd64-netinst\.iso)\.torrent"/.exec(listing)?.[1];
      if (!name) fail(`couldn't find the netinst .torrent on ${DEBIAN}bt-cd/. pass --source instead`);
      source = `${DEBIAN}bt-cd/${name}.torrent`;
      if (opts.full) {
        const sums = await (await fetch(`${DEBIAN}iso-cd/SHA256SUMS`)).text().catch(() => '');
        expectSha = new RegExp(`^([0-9a-f]{64})\\s+${name.replace(/\./g, '\\.')}$`, 'm').exec(sums)?.[1] ?? null;
      }
    }
    added = await call('POST', '/api/torrents', { source });
  }
  if (added.status !== 201) fail(`adding failed: ${added.status} ${added.json?.message ?? added.text.slice(0, 200)}`);
  const hash = added.json.torrent.hash;
  ok(`added ${added.json.torrent.name} (${hash})`);

  try {
    // 4. wait for metadata, pick every file, wait for it to finish
    const deadline = Date.now() + opts.timeout * 60_000;
    let last = '';
    let picked = false;
    let torrent;
    for (;;) {
      if (Date.now() > deadline) fail(`gave up after ${opts.timeout} minutes in state "${torrent?.state}"`);
      const r = await call('GET', `/api/torrents/${hash}`);
      if (r.status !== 200) fail(`reading the torrent failed: ${r.status} ${r.json?.message ?? ''}`);
      torrent = r.json.torrent;
      if (torrent.state === 'error') fail('the torrent went into an error state');
      if (torrent.state === 'selecting' && !picked) {
        const files = (await call('GET', `/api/torrents/${hash}/files`)).json.files;
        const sel = await call('POST', `/api/torrents/${hash}/select`, { files: files.map((f) => f.index) });
        if (sel.status !== 200) fail(`picking files failed: ${sel.status} ${sel.json?.message ?? ''}`);
        picked = true;
        ok(`metadata arrived, picked ${files.length} file${files.length === 1 ? '' : 's'} (${fmt(sel.json.torrent.selectedSize)})`);
      }
      if (torrent.state === 'done' || torrent.state === 'seeding') break;
      const line = `${torrent.state} ${(torrent.progress * 100).toFixed(0)}% · ${fmt(torrent.dlSpeed)}/s · ${torrent.peers} peers · ${torrent.seeds} seeds`;
      if (line !== last) info(line);
      last = line;
      await sleep(3000);
    }
    ok(`finished: ${fmt(torrent.selectedSize)}`);

    // 5. the download domain serves it
    const links = await call('GET', `/api/torrents/${hash}/links`);
    const file = links.json?.files?.[0];
    if (!file) fail(`no download links: ${links.status} ${links.text.slice(0, 200)}`);
    const head = await fetch(file.url, { method: 'HEAD' });
    if (head.status !== 200 || Number(head.headers.get('content-length')) !== file.size) {
      fail(`download domain answered ${head.status} with length ${head.headers.get('content-length')} (expected ${file.size})`);
    }
    ok(`download link works over ${new URL(file.url).protocol.replace(':', '')} (${new URL(file.url).host})`);
    const part = await fetch(file.url, { headers: { range: 'bytes=0-1048575' } });
    const partBytes = (await part.arrayBuffer()).byteLength;
    if (part.status !== 206 || partBytes !== Math.min(1048576, file.size)) fail(`range request answered ${part.status} with ${partBytes} bytes`);
    ok('resumable downloads work (byte ranges)');
    if (links.json.zip) {
      const z = await fetch(links.json.zip.url, { method: 'HEAD' });
      if (z.status !== 200) fail(`zip link answered ${z.status}`);
      ok('zip link works');
    }

    if (opts.full) {
      info(`downloading the whole file (${fmt(file.size)})`);
      const res = await fetch(file.url);
      const h = createHash('sha256');
      let n = 0;
      for await (const chunk of res.body) {
        h.update(chunk);
        n += chunk.length;
      }
      const sha = h.digest('hex');
      if (n !== file.size) fail(`got ${n} bytes, expected ${file.size}`);
      if (expectSha && sha !== expectSha) fail(`sha-256 ${sha} doesn't match debian's ${expectSha}`);
      ok(expectSha ? `sha-256 matches debian's published checksum` : `downloaded ${fmt(n)}, sha-256 ${sha}`);
    }
  } finally {
    if (!opts.keep) {
      const del = await call('DELETE', `/api/torrents/${hash}`);
      if (del.status === 204) ok('removed it again');
      else console.log(`${t()}  warn  couldn't remove it (${del.status}); it will expire on its own`);
    }
  }
  console.log(`${t()}  PASS`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.log(`${t()}  FAIL  ${err instanceof Fail ? err.message : err.stack ?? err}`);
    process.exit(1);
  },
);
