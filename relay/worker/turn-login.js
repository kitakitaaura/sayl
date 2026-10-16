/**
 * TURN logins for the DHT, from a TURN account set with secrets. Used by the
 * relay (/turn-credentials) and by the Sayl website (/api/turn), so relays
 * without a TURN account of their own still reach the DHT.
 *
 *   Metered (logins made on demand, expire after 2 hours):
 *     METERED_APP          the app name (the part before .metered.live)
 *     METERED_SECRET_KEY   the secret key
 *     METERED_TURN_HOST    optional, default standard.relay.metered.ca
 *   or a fixed login from any provider:
 *     TURN_URLS            comma-separated, e.g. turns:host:443?transport=tcp
 *     TURN_USERNAME, TURN_CREDENTIAL
 *
 * Returns { status, body }: body is { servers: [{ url, username, credential }] },
 * or { servers: [], error } when none is set up (200) or the provider fails (503).
 */
let meteredCache = null; // { key, servers, expiresAt }, shared by requests on this isolate

const TTL_SECONDS = 2 * 60 * 60;

export function hasTurnLogins(env) {
  return !!((env.METERED_APP && env.METERED_SECRET_KEY) || (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL));
}

export async function turnLogins(env) {
  if (env.METERED_APP && env.METERED_SECRET_KEY) {
    const key = `${env.METERED_APP}|${env.METERED_TURN_HOST ?? ''}`;
    // a login is reused until 15 minutes before it expires
    if (meteredCache?.key === key && meteredCache.expiresAt - Date.now() > 15 * 60_000) return { status: 200, body: { servers: meteredCache.servers } };
    const base = (env.METERED_API_BASE || `https://${env.METERED_APP}.metered.live`).replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/api/v1/turn/credential?secretKey=${encodeURIComponent(env.METERED_SECRET_KEY)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expiryInSeconds: TTL_SECONDS, label: 'sayl-dht' }),
      });
    } catch (err) {
      return { status: 503, body: { servers: [], error: `the TURN provider is unreachable: ${err.message}` } };
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.username || !body.password) {
      return { status: 503, body: { servers: [], error: `the TURN provider refused (${res.status}${body.message ? `: ${body.message}` : ''})` } };
    }
    const host = env.METERED_TURN_HOST || 'standard.relay.metered.ca';
    const servers = [`turns:${host}:443?transport=tcp`, `turn:${host}:80?transport=tcp`].map((url) => ({ url, username: body.username, credential: body.password }));
    meteredCache = { key, servers, expiresAt: Date.now() + TTL_SECONDS * 1000 };
    return { status: 200, body: { servers } };
  }
  if (env.TURN_URLS && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    const servers = env.TURN_URLS.split(',')
      .map((u) => u.trim())
      .filter(Boolean)
      .map((url) => ({ url, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }));
    return { status: 200, body: { servers } };
  }
  return { status: 200, body: { servers: [], error: 'the DHT is not set up here' } };
}
