/**
 * Sayl relay: lets a browser reach BitTorrent peers and HTTP trackers over TCP.
 *
 *   GET /tunnel?host=<ip|name>&port=<n>[&tls=1][&via=do&session=<id>][&token=<t>]
 *   (WebSocket upgrade)
 *
 * Binary WebSocket messages are TCP bytes in each direction. Text messages are
 * control: the relay sends {"t":"open"} once the TCP connection is up and
 * {"t":"error","m":"..."} before closing on a failure.
 *
 *   GET /turn-credentials[?token=<t>]
 *
 * Gives the browser a short-lived TURN login so it can reach the DHT (see
 * turn-login.js). No TURN account set up: an empty list and the reason.
 *
 * via=worker (default) relays inside the Worker request itself. via=do hands
 * the WebSocket to a Durable Object chosen by `session`, so one browser
 * download shares one object. Sayl uses via=do: Durable Objects get far more
 * CPU time per message than a plain Worker request on the free plan.
 */
import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';
import { turnLogins } from './turn-login.js';
import { LIST_OBJECT, handleList } from './list.js';
import { BT_HANDSHAKE_LENGTH, BT_PREFIX, MAX_ANNOUNCE_RESPONSE, isAnnounceRequest, isTurnAllocate, isTurnHost, parseTarget, startsWithBtHandshake, turnHosts } from './policy.js';

/**
 * Bumped whenever the relay changes in a way people should update for. The website compares it with
 * the version it was built with and offers an update. Relays from before this field count as 1.
 */
const RELAY_VERSION = 3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ status: 'ok', version: RELAY_VERSION }, { headers: { ...CORS, 'cache-control': 'no-store' } });
    if (url.pathname === '/turn-credentials') return turnCredentials(url, env);
    if (url.pathname === '/list') return listRequest(request, url, env);
    if (url.pathname !== '/tunnel') return new Response('not found', { status: 404 });

    const refused = checkRequest(request, url, env);
    if (refused) return refused;
    if (url.searchParams.get('via') === 'do') {
      const session = url.searchParams.get('session') ?? '';
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(session)) return new Response('bad session', { status: 400 });
      return env.SESSIONS.get(env.SESSIONS.idFromName(session)).fetch(request);
    }
    return openTunnel(url, env);
  },
};

/** The shared torrent list (list.js), kept by one Durable Object. Sent as text/plain, so no CORS preflight. */
async function listRequest(request, url, env) {
  const headers = { ...CORS, 'cache-control': 'no-store' };
  if (env.ACCESS_TOKEN && url.searchParams.get('token') !== env.ACCESS_TOKEN) return Response.json({ error: 'bad token' }, { status: 403, headers });
  const res = await env.SESSIONS.get(env.SESSIONS.idFromName(LIST_OBJECT)).fetch(request);
  return new Response(res.body, { status: res.status, headers: { ...headers, 'content-type': 'application/json' } });
}

/**
 * One Durable Object per browser download; it relays all of that download's tunnels.
 * One more, named LIST_OBJECT, keeps the shared torrent list.
 */
export class Session extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/list') return handleList(request, this.ctx.storage);
    return openTunnel(url, this.env);
  }
}

/** The Sayl website runs on another origin; it reads /health and /turn-credentials with the token. */
const CORS = { 'access-control-allow-origin': '*' };

/** A TURN login for the DHT, from this relay's own TURN account (see turn-login.js). */
async function turnCredentials(url, env) {
  const json = (body, status = 200) => Response.json(body, { status, headers: { ...CORS, 'cache-control': 'no-store' } });
  if (env.ACCESS_TOKEN && url.searchParams.get('token') !== env.ACCESS_TOKEN) return json({ error: 'bad token' }, 403);
  const { status, body } = await turnLogins(env);
  return json(body, status);
}

function checkRequest(request, url, env) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a websocket', { status: 426 });
  if (env.ACCESS_TOKEN && url.searchParams.get('token') !== env.ACCESS_TOKEN) return new Response('bad token', { status: 403 });
  return null;
}

function openTunnel(url, env) {
  const target = parseTarget(url.searchParams, { allowPrivate: env.ALLOW_PRIVATE_TARGETS === '1' });
  if (target.error) return new Response(target.error, { status: 400 });
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  // Newer compatibility dates deliver binary messages as Blobs unless told otherwise.
  server.binaryType = 'arraybuffer';
  relay(server, target, isTurnHost(target.host, turnHosts(env.TURN_HOSTS)));
  return new Response(null, { status: 101, webSocket: client });
}

function relay(ws, { host, port, tls }, turnAllowed) {
  let socket;
  let closed = false;
  /** 'start' → first browser message decides: 'bt' (waiting for the remote handshake) or 'http'; then 'open'. */
  let mode = 'start';
  const held = [];
  let remoteHead = new Uint8Array(0);
  let responseBytes = 0;

  const close = (message) => {
    if (closed) return;
    closed = true;
    if (message) trySend(ws, JSON.stringify({ t: 'error', m: message }));
    try {
      ws.close(message ? 1011 : 1000, message ? message.slice(0, 120) : 'done');
    } catch {}
    socket?.close().catch(() => {});
  };

  try {
    socket = connect({ hostname: host, port }, { secureTransport: tls ? 'on' : 'off', allowHalfOpen: false });
  } catch (err) {
    close(`connect failed: ${err.message}`);
    return;
  }
  const writer = socket.writable.getWriter();
  const write = (bytes) => writer.write(bytes).catch((err) => close(`write failed: ${err.message}`));

  socket.opened.then(
    () => trySend(ws, JSON.stringify({ t: 'open' })),
    (err) => close(`connect failed: ${err.message}`),
  );

  ws.addEventListener('message', (event) => {
    if (closed || typeof event.data === 'string') return;
    if (!(event.data instanceof ArrayBuffer)) return close('unexpected message type');
    const bytes = new Uint8Array(event.data);
    if (mode === 'start') {
      if (startsWithBtHandshake(bytes) && !tls) {
        mode = 'bt';
        write(bytes.subarray(0, BT_HANDSHAKE_LENGTH));
        if (bytes.length > BT_HANDSHAKE_LENGTH) held.push(bytes.slice(BT_HANDSHAKE_LENGTH));
      } else if (isAnnounceRequest(bytes)) {
        mode = 'http';
        write(bytes);
      } else if (turnAllowed && isTurnAllocate(bytes)) {
        mode = 'open';
        write(bytes);
      } else {
        close('only bittorrent connections and tracker announces are relayed');
      }
      return;
    }
    if (mode === 'http') return close('one announce per tunnel');
    if (mode === 'bt') held.push(bytes);
    else write(bytes);
  });
  ws.addEventListener('close', () => close());
  ws.addEventListener('error', () => close());

  (async () => {
    const reader = socket.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || closed) break;
        if (mode === 'bt') {
          // Pass nothing on, in either direction, until the remote has proven it speaks BitTorrent.
          const joined = new Uint8Array(remoteHead.length + value.length);
          joined.set(remoteHead);
          joined.set(value, remoteHead.length);
          remoteHead = joined;
          if (remoteHead.length < BT_PREFIX.length) continue;
          if (!startsWithBtHandshake(remoteHead)) return close('the remote is not a bittorrent peer');
          mode = 'open';
          trySend(ws, remoteHead);
          for (const bytes of held.splice(0)) write(bytes);
          continue;
        }
        if (mode === 'http') {
          responseBytes += value.length;
          if (responseBytes > MAX_ANNOUNCE_RESPONSE) return close('announce response too large');
        } else if (mode === 'start') {
          return close('the remote spoke first');
        }
        trySend(ws, value);
      }
      close();
    } catch (err) {
      close(`read failed: ${err.message}`);
    }
  })();
}

function trySend(ws, data) {
  try {
    ws.send(data);
  } catch {}
}
