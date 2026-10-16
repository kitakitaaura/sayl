#!/usr/bin/env node
/**
 * Tests "set up with cloudflare" end to end, against a stand-in for Cloudflare:
 *   a fake sign-in (OAuth with PKCE) and a fake API record what Sayl asks for,
 *   the website's Worker runs in `wrangler dev`, Chromium clicks through it,
 *   and the relay Sayl "uploaded" is then run for real to show it works.
 *
 * Needs playwright-core (npm install --no-save playwright-core@1.56.1).
 *   node test/setup.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const frontend = join(root, '../frontend');
const FAKE_PORT = 18950;
const SITE_PORT = 18951;
const RELAY_PORT = 18952;
const CLIENT_ID = 'test-client';
const CLIENT_SECRET = 'test-secret';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
};
const work = mkdtempSync(join(tmpdir(), 'sayl-setup-'));
const cleanups = [];
const cleanup = () => {
  for (const c of cleanups.reverse()) {
    try {
      c();
    } catch {}
  }
};

// ── the stand-in for Cloudflare ─────────────────────────────────────────────
const fake = {
  deny: false,
  challenge: null,
  codes: new Map(), // code → { challenge, redirect }
  tokens: new Set(),
  revoked: [],
  exchanges: [],
  uploads: [], // { metadata, files }
  script: null, // the current script: { bindings }
  subdomain: null,
  takenOnce: true, // the first subdomain asked for is "taken" (error 10031)
  subdomainPuts: 0,
  enabled: [],
  deletedSecrets: [],
  apiCalls: [],
  meteredLogins: 0,
};
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const ok = (res, result) => json(res, 200, { success: true, errors: [], result });
const fail = (res, status, code, message) => json(res, status, { success: false, errors: [{ code, message }], result: null });
const readBody = (req) =>
  new Promise((resolve) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${FAKE_PORT}`);
  const body = await readBody(req);
  // the stand-in for Metered's API, which makes TURN logins for the website to hand out
  if (req.method === 'POST' && url.pathname === '/api/v1/turn/credential') {
    if (url.searchParams.get('secretKey') !== 'metered-key') return json(res, 401, { message: 'bad key' });
    fake.meteredLogins++;
    return json(res, 200, { username: `metered-user-${fake.meteredLogins}`, password: 'metered-pass', expiryInSeconds: JSON.parse(body.toString()).expiryInSeconds });
  }
  if (url.pathname === '/oauth2/auth') {
    const p = url.searchParams;
    const redirect = p.get('redirect_uri');
    const good =
      p.get('response_type') === 'code' &&
      p.get('client_id') === CLIENT_ID &&
      p.get('code_challenge_method') === 'S256' &&
      /^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge') ?? '') &&
      ['account-settings.read', 'workers-scripts.admin', 'workers-scripts.edit'].every((s) => (p.get('scope') ?? '').split(' ').includes(s)) &&
      !!p.get('state');
    if (!good) return fail(res, 400, 0, `bad authorize request: ${url.search}`);
    const back = new URL(redirect);
    if (fake.deny) back.searchParams.set('error', 'access_denied');
    else {
      const code = randomBytes(8).toString('hex');
      fake.codes.set(code, { challenge: p.get('code_challenge'), redirect });
      back.searchParams.set('code', code);
    }
    back.searchParams.set('state', p.get('state'));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (url.pathname === '/oauth2/token') {
    const form = new URLSearchParams(body.toString());
    const auth = req.headers.authorization ?? '';
    const basicOk = auth === `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
    const saved = fake.codes.get(form.get('code'));
    const pkceOk = saved && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === saved.challenge;
    const redirectOk = saved && form.get('redirect_uri') === saved.redirect;
    fake.exchanges.push({ basicOk, pkceOk, redirectOk, grant: form.get('grant_type') });
    if (!basicOk || !pkceOk || !redirectOk || form.get('grant_type') !== 'authorization_code') return json(res, 400, { error: 'invalid_grant' });
    fake.codes.delete(form.get('code'));
    const token = randomBytes(12).toString('hex');
    fake.tokens.add(token);
    return json(res, 200, { access_token: token, token_type: 'bearer', expires_in: 3600 });
  }
  if (url.pathname === '/oauth2/revoke') {
    const form = new URLSearchParams(body.toString());
    fake.revoked.push(form.get('token'));
    fake.tokens.delete(form.get('token'));
    res.writeHead(200);
    return res.end();
  }
  if (!url.pathname.startsWith('/client/v4/')) return fail(res, 404, 0, 'not found');
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!fake.tokens.has(bearer)) return fail(res, 403, 10000, 'Authentication error');
  const path = url.pathname.slice('/client/v4'.length);
  fake.apiCalls.push(`${req.method} ${path}`);
  const S = '/accounts/acc1/workers/scripts/sayl-relay';
  if (req.method === 'GET' && path === '/accounts') return ok(res, [{ id: 'acc1', name: 'Test account' }]);
  if (req.method === 'GET' && path === `${S}/settings`) {
    return fake.script ? ok(res, { bindings: fake.script.bindings }) : fail(res, 404, 10007, 'workers.api.error.script_not_found');
  }
  if (req.method === 'DELETE' && path.startsWith(`${S}/secrets/`)) {
    const name = path.split('/').pop();
    fake.deletedSecrets.push(name);
    if (fake.script) fake.script.bindings = fake.script.bindings.filter((b) => b.name !== name);
    return ok(res, null);
  }
  if (req.method === 'GET' && path === '/accounts/acc1/workers/services/sayl-relay') {
    return fake.script ? ok(res, { default_environment: { script: { migration_tag: fake.script.migrationTag } } }) : fail(res, 404, 10090, 'service not found');
  }
  if (req.method === 'PUT' && path === S) {
    // like Cloudflare: no Worker uploads until the account has a workers.dev subdomain
    if (!fake.subdomain) return fail(res, 400, 10063, 'You need a workers.dev subdomain in order to proceed.');
    const request = new Request('http://x', { method: 'PUT', headers: { 'content-type': req.headers['content-type'] }, body });
    const form = await request.formData();
    const metadata = JSON.parse(form.get('metadata'));
    const files = {};
    for (const [name, value] of form.entries()) if (name !== 'metadata') files[name] = { type: value.type, text: await value.text() };
    fake.uploads.push({ metadata, files });
    const kept = (fake.script?.bindings ?? []).filter((b) => (metadata.keep_bindings ?? []).includes(b.type));
    fake.script = {
      bindings: [...kept.filter((k) => !metadata.bindings.some((b) => b.name === k.name)), ...metadata.bindings],
      migrationTag: metadata.migrations?.new_tag ?? fake.script?.migrationTag ?? null,
    };
    return ok(res, { id: 'sayl-relay' });
  }
  if (req.method === 'GET' && path === '/accounts/acc1/workers/subdomain') {
    return fake.subdomain ? ok(res, { subdomain: fake.subdomain }) : fail(res, 404, 10007, 'subdomain not found');
  }
  if (req.method === 'PUT' && path === '/accounts/acc1/workers/subdomain') {
    fake.subdomainPuts++;
    if (fake.takenOnce) {
      fake.takenOnce = false;
      return fail(res, 409, 10031, 'subdomain unavailable');
    }
    fake.subdomain = JSON.parse(body.toString()).subdomain;
    return ok(res, { subdomain: fake.subdomain });
  }
  if (req.method === 'POST' && path === `${S}/subdomain`) {
    fake.enabled.push({ body: JSON.parse(body.toString()), apiDate: req.headers['cloudflare-workers-script-api-date'] });
    return ok(res, { enabled: true, previews_enabled: false });
  }
  return fail(res, 404, 0, `no fake for ${req.method} ${path}`);
});

try {
  await new Promise((r) => server.listen(FAKE_PORT, '127.0.0.1', r));
  cleanups.push(() => server.close());

  // ── the website, with its Worker ──────────────────────────────────────────
  execFileSync('npm', ['run', 'build'], { cwd: frontend, env: { ...process.env, ENGINE: 'browser', API_URL: '' }, stdio: 'ignore' });
  const site = spawn(
    join(frontend, 'node_modules/.bin/wrangler'),
    [
      'dev', '--port', String(SITE_PORT), '--ip', '127.0.0.1',
      '--var', `OAUTH_CLIENT_ID:${CLIENT_ID}`, '--var', `OAUTH_CLIENT_SECRET:${CLIENT_SECRET}`, '--var', `SESSION_SECRET:${randomBytes(16).toString('hex')}`,
      '--var', `CF_AUTH_BASE:http://127.0.0.1:${FAKE_PORT}`, '--var', `CF_API_BASE:http://127.0.0.1:${FAKE_PORT}/client/v4`,
      '--var', `RELAY_CHECK_BASE:http://127.0.0.1:${RELAY_PORT}`,
      '--var', 'METERED_APP:sayltest', '--var', 'METERED_SECRET_KEY:metered-key', '--var', `METERED_API_BASE:http://127.0.0.1:${FAKE_PORT}`,
    ],
    { cwd: frontend, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: 'ignore' },
  );
  cleanups.push(() => site.kill('SIGTERM'));
  const siteUrl = `http://localhost:${SITE_PORT}`;
  await until(async () => (await fetch(`${siteUrl}/api/relay/available`)).ok, 90, 'the website worker');
  const availableBody = await (await fetch(`${siteUrl}/api/relay/available`)).json();
  check('the site says automatic setup and the DHT are available', availableBody.available === true && availableBody.dht === true);
  const slash = await fetch(`${siteUrl}/api/relay/available/`);
  const missing = await fetch(`${siteUrl}/api/relay/nope`);
  check(
    'a trailing slash still finds the route; an unknown one says which path it got',
    slash.ok && (await slash.json()).available === true && missing.status === 404 && (await missing.json()).path === '/api/relay/nope',
  );
  const turn1 = await (await fetch(`${siteUrl}/api/turn`)).json();
  const turn2Res = await fetch(`${siteUrl}/api/turn`);
  const turn2 = await turn2Res.json();
  check(
    'the site hands out a Metered TURN login, and reuses it',
    turn1.servers?.length === 2 &&
      turn1.servers[0].url === 'turns:standard.relay.metered.ca:443?transport=tcp' &&
      turn1.servers.every((x) => x.username === 'metered-user-1' && x.credential === 'metered-pass') &&
      turn2.servers?.[0]?.username === 'metered-user-1' &&
      fake.meteredLogins === 1 &&
      turn2Res.headers.get('access-control-allow-origin') === null,
    JSON.stringify(turn1.servers?.[0]),
  );
  check('the site still serves its pages', (await fetch(`${siteUrl}/settings`)).status === 200 && (await fetch(`${siteUrl}/no-such-page`)).status === 404);

  // A callback without the sign-in cookie is turned away.
  const forged = await fetch(`${siteUrl}/api/relay/callback?code=x&state=y`, { redirect: 'manual' });
  const fragment = (location) => new URLSearchParams(new URL(location).hash.slice(1));
  const checkStatus = async (u) => (await fetch(`${siteUrl}/api/relay/check?url=${encodeURIComponent(u)}`)).status;
  check(
    'the relay check only looks at relay addresses',
    (await checkStatus('https://example.com')) === 400 && (await checkStatus('https://sayl-relay.x.workers.dev.example.com')) === 400 && (await checkStatus('https://sayl-relay.x.workers.dev')) === 200,
  );
  check('a forged callback is refused', forged.status === 302 && (fragment(forged.headers.get('location')).get('relay-error') ?? '').includes('expired or came from somewhere else'));

  // ── a person clicking through ─────────────────────────────────────────────
  const { chromium } = await import(join(root, 'node_modules/playwright-core/index.mjs'));
  const browser = await chromium.launch();
  cleanups.push(() => browser.close());
  const context = await browser.newContext();
  let relayProxyHits = 0;
  // Like the bug seen on the real Cloudflare: the page that waits for the new relay can't reach it,
  // though the relay is up and a reload reaches it fine.
  let loads = 0;
  let staleOnce = true;
  let staleLoad = null;
  // The new relay's workers.dev address is answered by the uploaded relay, run locally (started below).
  await context.route(/^https:\/\/sayl-relay\.[a-z0-9-]+\.workers\.dev\//, async (route) => {
    relayProxyHits++;
    if (staleOnce && staleLoad === null) staleLoad = loads;
    if (staleOnce && loads === staleLoad) return route.abort();
    const u = new URL(route.request().url());
    try {
      const r = await fetch(`http://127.0.0.1:${RELAY_PORT}${u.pathname}${u.search}`);
      await route.fulfill({ status: r.status, headers: { 'access-control-allow-origin': '*', 'content-type': r.headers.get('content-type') ?? 'text/plain' }, body: Buffer.from(await r.arrayBuffer()) });
    } catch {
      await route.abort();
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('domcontentloaded', () => loads++);
  let serverChecks = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/relay/check')) serverChecks++;
  });

  await page.goto(siteUrl);
  await page.getByRole('button', { name: 'set up with cloudflare' }).waitFor({ timeout: 20_000 });
  check('the setup screen offers "set up with cloudflare"', true);

  // Run the uploaded relay as soon as it exists, so the page's health check can reach it.
  let relayProc = null;
  const startRelay = () => {
    const up = fake.uploads.at(-1);
    const dir = join(work, `relay-${fake.uploads.length}`);
    execFileSync('mkdir', ['-p', dir]);
    for (const [name, f] of Object.entries(up.files)) writeFileSync(join(dir, name), f.text);
    const vars = Object.fromEntries(up.metadata.bindings.filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text]));
    const doBinding = up.metadata.bindings.find((b) => b.type === 'durable_object_namespace');
    const toml = [
      `name = "uploaded-relay"`,
      `main = "${up.metadata.main_module}"`,
      `compatibility_date = "${up.metadata.compatibility_date}"`,
      `[[durable_objects.bindings]]`,
      `name = "${doBinding.name}"`,
      `class_name = "${doBinding.class_name}"`,
      `[[migrations]]`,
      `tag = "v1"`,
      `new_sqlite_classes = ["${doBinding.class_name}"]`,
      `[vars]`,
      ...Object.entries(vars).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
    ].join('\n');
    writeFileSync(join(dir, 'wrangler.toml'), toml);
    relayProc = spawn(join(root, 'node_modules/.bin/wrangler'), ['dev', '--port', String(RELAY_PORT), '--ip', '127.0.0.1'], {
      cwd: dir,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
      stdio: 'ignore',
    });
    cleanups.push(() => relayProc.kill('SIGTERM'));
  };

  await page.getByRole('button', { name: 'set up with cloudflare' }).click();
  await until(async () => fake.uploads.length === 1, 30, 'the relay upload');
  startRelay();
  await until(async () => (await fetch(`http://127.0.0.1:${RELAY_PORT}/health`)).ok, 90, 'the uploaded relay to start');
  const hitsBeforeUp = relayProxyHits;
  // ready = the relay is saved, it answered, and the add box is showing
  const ready = () =>
    page.waitForFunction(
      () => !!localStorage.getItem('sayl.relay') && !!document.querySelector('form[aria-label="add a torrent"]') && !document.body.innerText.includes('waiting for it to come online'),
      null,
      { timeout: 120_000 },
    );
  await page.getByText('your relay is ready').waitFor({ timeout: 120_000 });
  await ready();
  check('after approving, the relay is installed and the site is ready', true, `${relayProxyHits} health checks`);
  check('until the relay is up, only the website checks it, not the browser', hitsBeforeUp === 0 && serverChecks > 0, `${serverChecks} checks by the website`);
  check('when the page itself can\'t reach the live relay, it reloads once by itself and carries on', staleLoad !== null && loads === staleLoad + 1, `${loads} page loads`);
  staleOnce = false;

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sayl.relay') ?? '{}'));
  const first = fake.uploads[0];
  const binding = (up, name) => up.metadata.bindings.find((b) => b.name === name);
  check('the sign-in used PKCE and the client secret, and was given back', fake.exchanges[0]?.basicOk && fake.exchanges[0]?.pkceOk && fake.exchanges[0]?.redirectOk && fake.revoked.length === 1);
  check(
    'the relay was uploaded as a module with its Durable Object and first migration',
    first.metadata.main_module === 'index.js' &&
      first.files['index.js']?.type === 'application/javascript+module' &&
      !!first.files['policy.js'] &&
      binding(first, 'SESSIONS')?.type === 'durable_object_namespace' &&
      first.metadata.migrations?.new_tag === 'v1' &&
      first.metadata.migrations?.steps?.[0]?.new_sqlite_classes?.[0] === 'Session' &&
      first.metadata.keep_bindings?.includes('secret_text'),
    JSON.stringify(first.metadata.migrations),
  );
  const order = fake.apiCalls.filter((c) => c.includes('/workers/subdomain') || c === 'PUT /accounts/acc1/workers/scripts/sayl-relay');
  check(
    'a brand-new account gets a workers.dev subdomain before the upload (after one name was taken)',
    fake.subdomainPuts === 2 && /^sayl-[0-9a-f]{8}$/.test(fake.subdomain ?? '') && order.indexOf('PUT /accounts/acc1/workers/subdomain') < order.indexOf('PUT /accounts/acc1/workers/scripts/sayl-relay'),
    fake.subdomain,
  );
  check('the relay was put on workers.dev', fake.enabled[0]?.body?.enabled === true && fake.enabled[0]?.apiDate === '2025-08-01');
  check(
    'the browser got the relay address and its token',
    saved.url === `https://sayl-relay.${fake.subdomain}.workers.dev` && saved.token === binding(first, 'ACCESS_TOKEN')?.text && saved.token.length >= 32,
    saved.url,
  );

  // The installed relay really is a working relay.
  const local = `http://127.0.0.1:${RELAY_PORT}`;
  check('the uploaded relay runs: /health answers', (await fetch(`${local}/health`)).ok);
  const { isTurnHost, turnHosts } = await import('../worker/policy.js');
  const relayTurn = await (await fetch(`${local}/turn-credentials?token=${saved.token}`)).json();
  check(
    "the new relay has no TURN login of its own, and may reach the site's TURN server",
    !!first.files['turn-login.js'] && Array.isArray(relayTurn.servers) && relayTurn.servers.length === 0 && isTurnHost('standard.relay.metered.ca', turnHosts(binding(first, 'TURN_HOSTS')?.text)),
  );
  check('the uploaded relay requires its token', (await fetch(`${local}/turn-credentials`)).status === 403 && (await fetch(`${local}/turn-credentials?token=${saved.token}`)).status === 200);

  // Setting up again (another device, or a repair) keeps the same token and skips the migration.
  await page.goto(`${siteUrl}/settings`);
  await page.getByRole('button', { name: 'set up again with cloudflare' }).click();
  await until(async () => fake.uploads.length === 2, 30, 'the second upload');
  await page.waitForURL((u) => !u.hash.includes('relay-') && u.pathname === '/', { timeout: 30_000 });
  await ready();
  const second = fake.uploads[1];
  const saved2 = await page.evaluate(() => JSON.parse(localStorage.getItem('sayl.relay') ?? '{}'));
  check('setting up again reuses the token and skips the migration', binding(second, 'ACCESS_TOKEN')?.text === saved.token && !second.metadata.migrations && saved2.token === saved.token);
  check('setting up again reuses the workers.dev subdomain', fake.subdomainPuts === 2 && saved2.url === saved.url);

  // A token set by hand (`wrangler secret put ACCESS_TOKEN`) is replaced by a readable one.
  fake.script.bindings = fake.script.bindings.filter((b) => b.name !== 'ACCESS_TOKEN').concat({ type: 'secret_text', name: 'ACCESS_TOKEN' });
  await page.goto(`${siteUrl}/settings`);
  await page.getByRole('button', { name: 'set up again with cloudflare' }).click();
  await until(async () => fake.uploads.length === 3, 30, 'the third upload');
  await page.waitForURL((u) => !u.hash.includes('relay-') && u.pathname === '/', { timeout: 30_000 });
  await ready();
  const third = fake.uploads[2];
  check('a hand-set secret token is swapped for a new readable one', fake.deletedSecrets.includes('ACCESS_TOKEN') && binding(third, 'ACCESS_TOKEN')?.text?.length >= 32 && binding(third, 'ACCESS_TOKEN')?.text !== saved.token);

  // Saying no on Cloudflare's page.
  fake.deny = true;
  await page.evaluate(() => localStorage.removeItem('sayl.relay'));
  await page.goto(siteUrl);
  await page.getByRole('button', { name: 'set up with cloudflare' }).click();
  await page.getByText('you cancelled on cloudflare').waitFor({ timeout: 20_000 });
  check('cancelling on cloudflare shows a clear message', fake.uploads.length === 3);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  check('every sign-in was given back', fake.tokens.size === 0, `${fake.revoked.length} revoked`);
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
