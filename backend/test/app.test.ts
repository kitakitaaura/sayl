import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApi } from '../src/app.js';
import { COOKIE_NAME } from '../src/session.js';
import { harness, json, ORIGIN, type Harness } from './harness.js';

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

describe('health', () => {
  it('returns 503 until qbittorrent is verified, then 200 without engine details', async () => {
    const starting = buildApi(h.cfg, { ready: false, error: 'waiting' }, { engine: h.engine });
    const r1 = await starting.inject({ method: 'GET', url: '/api/health' });
    expect(r1.statusCode).toBe(503);
    expect(r1.json()).toEqual({ app: 'Sayl', status: 'starting' });
    const r2 = await h.api.inject({ method: 'GET', url: '/api/health' });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual({ app: 'Sayl', status: 'ok' });
    await starting.close();
  });

  it('keeps api and download routes on separate servers', async () => {
    expect((await h.api.inject({ method: 'GET', url: '/dl/health' })).statusCode).toBe(404);
    expect((await h.dl.inject({ method: 'GET', url: '/dl/health' })).statusCode).toBe(200);
    expect((await h.dl.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(404);
  });
});

describe('sessions', () => {
  it('reports no session, then creates one with a signed httpOnly cookie', async () => {
    const before = await h.api.inject({ method: 'GET', url: '/api/session' });
    expect(json(before).session).toBeNull();
    expect(json<{ limits: { maxActive: number } }>(before).limits.maxActive).toBe(3);

    const r = await h.api.inject({ method: 'POST', url: '/api/session', headers: { origin: ORIGIN } });
    expect(r.statusCode).toBe(201);
    const c = r.cookies.find((x) => x.name === COOKIE_NAME)!;
    expect(c.httpOnly).toBe(true);
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe('Lax');
    expect(c.value).toMatch(/^[A-Za-z0-9_-]{24}\.[A-Za-z0-9_+/=-]+$/);

    const after = await h.api.inject({ method: 'GET', url: '/api/session', headers: { cookie: `${c.name}=${c.value}` } });
    expect(json(after).session).toEqual({ active: true });
  });

  it('reuses an existing session instead of replacing it', async () => {
    const u = await h.user();
    const r = await u.post('/api/session');
    expect(r.statusCode).toBe(200);
    expect(r.cookies.find((x) => x.name === COOKIE_NAME)).toBeUndefined();
  });

  it('ignores forged or tampered cookies', async () => {
    const u = await h.user();
    const value = u.cookie.split('=')[1]!;
    const forged = `${COOKIE_NAME}=AAAAAAAAAAAAAAAAAAAAAAAA.${value.split('.')[1]}`;
    for (const cookie of [forged, `${COOKIE_NAME}=AAAAAAAAAAAAAAAAAAAAAAAA`, `${COOKIE_NAME}=${value}x`]) {
      const r = await h.api.inject({ method: 'GET', url: '/api/torrents', headers: { cookie } });
      expect(r.statusCode).toBe(401);
    }
  });

  it('requires a session for every torrent route', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/torrents'],
      ['POST', '/api/torrents'],
      ['DELETE', '/api/torrents'],
      ['GET', `/api/torrents/${'a'.repeat(40)}`],
      ['GET', `/api/torrents/${'a'.repeat(40)}/files`],
      ['GET', `/api/torrents/${'a'.repeat(40)}/links`],
      ['POST', `/api/torrents/${'a'.repeat(40)}/pause`],
      ['DELETE', `/api/torrents/${'a'.repeat(40)}`],
      ['GET', '/api/events'],
    ];
    for (const [method, url] of routes) {
      const r = await h.api.inject({ method: method as 'GET', url, headers: { origin: ORIGIN } });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('ends the session by clearing the cookie', async () => {
    const u = await h.user();
    const r = await u.del('/api/session');
    expect(r.statusCode).toBe(204);
    const c = r.cookies.find((x) => x.name === COOKIE_NAME)!;
    expect(c.value).toBe('');
  });
});

describe('cross-site protection', () => {
  it('refuses state-changing requests from other origins', async () => {
    const u = await h.user();
    const r = await h.api.inject({
      method: 'POST',
      url: '/api/torrents',
      headers: { cookie: u.cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: JSON.stringify({ source: `magnet:?xt=urn:btih:${'a'.repeat(40)}` }),
    });
    expect(r.statusCode).toBe(403);
    expect(h.fake.torrents.size).toBe(0);
  });

  it('allows the frontend origin with credentials', async () => {
    const r = await h.api.inject({ method: 'OPTIONS', url: '/api/torrents', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
    expect(r.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(r.headers['access-control-allow-credentials']).toBe('true');
    const evil = await h.api.inject({ method: 'OPTIONS', url: '/api/torrents', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    // the allowed origin is fixed, so a browser on another site sees a mismatch and blocks the response
    expect(evil.headers['access-control-allow-origin']).toBe(ORIGIN);
  });
});
