/**
 * The website's Worker. It serves the built site (static assets) and, under
 * /api/relay, installs a visitor's relay into their own Cloudflare account:
 *
 *   GET /api/relay/available   whether this site can do that ({ "available": true })
 *   GET /api/relay/connect     sends the visitor to Cloudflare to approve Sayl
 *   GET /api/relay/callback    Cloudflare sends them back here; Sayl uploads the
 *                              relay, turns on its workers.dev address, gives
 *                              the sign-in back (revokes it), and sends the
 *                              browser home with the relay's address and token
 *   GET /api/relay/check?url=…  whether a new relay answers yet, asked from
 *                              Cloudflare's side so the visitor's browser doesn't
 *                              try (and remember a failure for) an address that
 *                              isn't live yet ({ "up": true })
 *
 * Nothing is stored: the sign-in lives only for the length of the callback.
 *
 * Secrets (wrangler secret put, or the dashboard):
 *   OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET   from Manage Account → OAuth clients
 *   SESSION_SECRET                         any long random string; signs the short-lived sign-in cookie
 * Optional: OAUTH_SCOPES, CF_AUTH_BASE, CF_API_BASE and RELAY_CHECK_BASE (for testing against a stand-in).
 */
import { RELAY } from './relay-source.js';

// Cloudflare's names for "Account Settings: Read" and "Workers: Admin" (creating a Worker needs Admin) and "Edit"
const DEFAULT_SCOPES = 'account-settings.read workers-scripts.admin workers-scripts.edit';
const COOKIE = 'sayl_oauth';
const COOKIE_PATH = '/api/relay';
const SCRIPT_API_DATE = '2025-08-01';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/relay/available') {
        return Response.json({ available: configured(env) }, { headers: { 'cache-control': 'no-store' } });
      }
      if (url.pathname === '/api/relay/connect') return await connect(url, env);
      if (url.pathname === '/api/relay/callback') return await callback(request, url, env);
      if (url.pathname === '/api/relay/check') return await check(url, env);
      if (url.pathname.startsWith('/api/')) return Response.json({ error: 'not found' }, { status: 404 });
    } catch (err) {
      return home(url, { 'relay-error': err instanceof SetupError ? err.message : 'something went wrong setting up your relay. try again.' });
    }
    return env.ASSETS.fetch(request);
  },
};

class SetupError extends Error {}

const configured = (env) => !!(env.OAUTH_CLIENT_ID && env.OAUTH_CLIENT_SECRET && env.SESSION_SECRET);
const authBase = (env) => (env.CF_AUTH_BASE || 'https://dash.cloudflare.com').replace(/\/+$/, '');
const apiBase = (env) => (env.CF_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
const redirectUri = (url) => `${url.origin}/api/relay/callback`;

/** Back to the home page, with values in the fragment (never sent to any server). */
function home(url, values, extraHeaders = {}) {
  const fragment = new URLSearchParams(values).toString();
  return new Response(null, {
    status: 302,
    headers: { location: `${url.origin}/#${fragment}`, 'cache-control': 'no-store', ...extraHeaders },
  });
}

/** Asks a newly installed relay for /health. Only relay addresses Sayl hands out, so it can't be used to fetch anything else. */
async function check(url, env) {
  const target = url.searchParams.get('url') ?? '';
  const headers = { 'cache-control': 'no-store' };
  if (!new RegExp(`^https://${RELAY.name}\\.[a-z0-9-]+\\.workers\\.dev$`).test(target)) {
    return Response.json({ error: 'not a relay address' }, { status: 400, headers });
  }
  const base = (env.RELAY_CHECK_BASE || target).replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/health?t=${randomString(6)}`, { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(6000) });
    const body = res.ok ? await res.json().catch(() => ({})) : {};
    return Response.json({ up: body.status === 'ok' }, { headers });
  } catch {
    return Response.json({ up: false }, { headers });
  }
}

// ── step 1: off to Cloudflare ─────────────────────────────────────────────

async function connect(url, env) {
  if (!configured(env)) throw new SetupError("automatic relay setup isn't available on this site.");
  const state = randomString(24);
  const verifier = randomString(48);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const cookie = await sign(env, { state, verifier, exp: Date.now() + 10 * 60_000 });
  const auth = new URL(`${authBase(env)}/oauth2/auth`);
  auth.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.OAUTH_CLIENT_ID,
    redirect_uri: redirectUri(url),
    scope: env.OAUTH_SCOPES || DEFAULT_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return new Response(null, {
    status: 302,
    headers: { location: auth.toString(), 'set-cookie': cookieHeader(url, cookie, 600), 'cache-control': 'no-store' },
  });
}

// ── step 2: back from Cloudflare ──────────────────────────────────────────

async function callback(request, url, env) {
  const clear = { 'set-cookie': cookieHeader(url, '', 0) };
  if (!configured(env)) throw new SetupError("automatic relay setup isn't available on this site.");
  const error = url.searchParams.get('error');
  if (error) {
    const msg = error === 'access_denied' ? 'you cancelled on cloudflare, so no relay was set up.' : `cloudflare said: ${url.searchParams.get('error_description') || error}`;
    return home(url, { 'relay-error': msg }, clear);
  }
  const saved = await verify(env, readCookie(request, COOKIE));
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!saved || saved.exp < Date.now() || !state || state !== saved.state || !code) {
    return home(url, { 'relay-error': 'that sign-in expired or came from somewhere else. start again.' }, clear);
  }

  const token = await exchange(env, code, redirectUri(url), saved.verifier);
  try {
    const relay = await install(env, token);
    return home(url, { 'relay-url': relay.url, 'relay-token': relay.token, 'relay-new': relay.newSubdomain ? '1' : '0' }, clear);
  } catch (err) {
    return home(url, { 'relay-error': err instanceof SetupError ? err.message : `couldn't install the relay: ${err?.message ?? err}` }, clear);
  } finally {
    // Sayl only needed the sign-in for this one install.
    await revoke(env, token).catch(() => {});
  }
}

async function exchange(env, code, redirect, verifier) {
  const res = await fetch(`${authBase(env)}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${env.OAUTH_CLIENT_ID}:${env.OAUTH_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.access_token !== 'string') {
    throw new SetupError(`cloudflare didn't accept the sign-in (${body.error_description || body.error || res.status}). start again.`);
  }
  return body.access_token;
}

async function revoke(env, token) {
  await fetch(`${authBase(env)}/oauth2/revoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${env.OAUTH_CLIENT_ID}:${env.OAUTH_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
  });
}

// ── step 3: install the relay ─────────────────────────────────────────────

/** Calls the Cloudflare API; returns `result`, or throws ApiError with Cloudflare's error code. */
async function cf(env, token, method, path, { json, form, headers = {} } = {}) {
  const res = await fetch(`${apiBase(env)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const first = body.errors?.[0];
    throw new ApiError(res.status, first?.code ?? 0, first?.message ?? `${method} ${path} failed (${res.status})`);
  }
  return body.result;
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = (err) => err instanceof ApiError && (err.status === 404 || err.code === 10007);

async function install(env, token) {
  const accounts = await cf(env, token, 'GET', '/accounts?per_page=50').catch((err) => {
    throw new SetupError(`couldn't read your cloudflare account (${err.message}).`);
  });
  if (!Array.isArray(accounts) || !accounts.length) throw new SetupError('that sign-in gave sayl no cloudflare account to use. pick an account on the approval page.');
  const account = await pickAccount(env, token, accounts.map((a) => a.id));
  const script = `/accounts/${account}/workers/scripts/${RELAY.name}`;

  // 1. A workers.dev subdomain for the account. A brand-new account has none, and Cloudflare
  // won't take a Worker upload without one, so register one first (like `wrangler deploy` does).
  const { subdomain, created: newSubdomain } = await ensureSubdomain(env, token, account);

  // 2. Reuse the relay's token if it already has one, so other devices keep working.
  let accessToken = null;
  try {
    const settings = await cf(env, token, 'GET', `${script}/settings`);
    const existing = (settings?.bindings ?? []).find((b) => b.name === 'ACCESS_TOKEN');
    if (existing?.type === 'plain_text' && typeof existing.text === 'string' && existing.text.length >= 16) accessToken = existing.text;
    else if (existing?.type === 'secret_text') {
      // set by hand with `wrangler secret put`; replaced by a readable one so setup can reuse it next time
      await cf(env, token, 'DELETE', `${script}/secrets/ACCESS_TOKEN`);
    }
  } catch (err) {
    if (!notFound(err)) throw err;
  }
  accessToken ??= randomString(32);

  // 3. The Durable Object class needs a migration the first time only.
  let migrationTag = null;
  try {
    const service = await cf(env, token, 'GET', `/accounts/${account}/workers/services/${RELAY.name}`);
    migrationTag = service?.default_environment?.script?.migration_tag ?? null;
  } catch (err) {
    if (!notFound(err)) throw err;
  }

  // 4. Upload the relay.
  const metadata = {
    main_module: 'index.js',
    compatibility_date: RELAY.compatibilityDate,
    bindings: [
      { type: 'durable_object_namespace', name: 'SESSIONS', class_name: 'Session' },
      { type: 'plain_text', name: 'ALLOW_PRIVATE_TARGETS', text: '0' },
      { type: 'plain_text', name: 'TURN_HOSTS', text: RELAY.turnHosts },
      { type: 'plain_text', name: 'ACCESS_TOKEN', text: accessToken },
    ],
    // keep secrets set by hand, like a TURN login
    keep_bindings: ['secret_text', 'secret_key'],
    ...(migrationTag ? {} : { migrations: { new_tag: 'v1', steps: [{ new_sqlite_classes: ['Session'] }] } }),
  };
  const form = new FormData();
  form.set('metadata', JSON.stringify(metadata));
  for (const [name, source] of Object.entries(RELAY.files)) {
    form.set(name, new File([source], name, { type: 'application/javascript+module' }));
  }
  await cf(env, token, 'PUT', script, { form }).catch((err) => {
    throw new SetupError(`cloudflare refused the relay upload (${err.message}).`);
  });

  // 5. Put it on its workers.dev address.
  await cf(env, token, 'POST', `${script}/subdomain`, {
    json: { enabled: true, previews_enabled: false },
    headers: { 'Cloudflare-Workers-Script-Api-Date': SCRIPT_API_DATE },
  });

  return { url: `https://${RELAY.name}.${subdomain}.workers.dev`, token: accessToken, newSubdomain };
}

/**
 * When the sign-in covers several accounts: the one that already has the relay,
 * else one with a workers.dev subdomain, else the first.
 */
async function pickAccount(env, token, ids) {
  if (ids.length === 1) return ids[0];
  const candidates = ids.slice(0, 10);
  for (const id of candidates) {
    try {
      await cf(env, token, 'GET', `/accounts/${id}/workers/scripts/${RELAY.name}/settings`);
      return id;
    } catch {
      // not here, or no access
    }
  }
  for (const id of candidates) {
    try {
      if ((await cf(env, token, 'GET', `/accounts/${id}/workers/subdomain`))?.subdomain) return id;
    } catch {
      // none
    }
  }
  return ids[0];
}

/** The account's workers.dev subdomain, registering a random one if it has none. */
async function ensureSubdomain(env, token, account) {
  try {
    const existing = (await cf(env, token, 'GET', `/accounts/${account}/workers/subdomain`))?.subdomain;
    if (existing) return { subdomain: existing, created: false };
  } catch (err) {
    if (!notFound(err)) throw new SetupError(`couldn't check your workers.dev address (${err.message}).`);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const made = (await cf(env, token, 'PUT', `/accounts/${account}/workers/subdomain`, { json: { subdomain: `sayl-${randomHex(4)}` } }))?.subdomain;
      if (made) return { subdomain: made, created: true };
    } catch (err) {
      if (err instanceof ApiError && err.code === 10031) continue; // that name is taken: try another
      throw new SetupError(`couldn't give your account a workers.dev address (${err.message}).`);
    }
  }
  throw new SetupError("couldn't find a free workers.dev address for your account. try again.");
}

// ── small helpers ─────────────────────────────────────────────────────────

function randomString(bytes) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))));
}

async function sign(env, value) {
  const data = base64url(new TextEncoder().encode(JSON.stringify(value)));
  return `${data}.${await hmac(env, data)}`;
}

async function verify(env, cookie) {
  if (!cookie || !cookie.includes('.')) return null;
  const [data, mac] = cookie.split('.');
  const expected = await hmac(env, data);
  if (mac.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const json = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function readCookie(request, name) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function cookieHeader(url, value, maxAge) {
  // Lax, so it comes back on Cloudflare's redirect to the callback
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}
