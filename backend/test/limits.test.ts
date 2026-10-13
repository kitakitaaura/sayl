import { afterEach, describe, expect, it } from 'vitest';
import { banIp, blockTorrent, listTorrents, normaliseHash, unbanIp, unblockTorrent } from '../src/admin.js';
import type { TorrentView } from '../src/engine.js';
import { RateLimiter } from '../src/limits.js';
import { QbitClient } from '../src/qbit.js';
import { COOKIE_NAME } from '../src/session.js';
import { harness as makeHarness, hashOf, json, ORIGIN, type Client, type Harness } from './harness.js';

let h: Harness;
let closed = true;
afterEach(async () => {
  if (!closed) await h.close();
  closed = true;
});
async function harness(env: Record<string, string> = {}) {
  closed = false;
  return makeHarness(env);
}

const GB = 1e9;
const HOUR = 3600_000;

/** Adds a magnet, gives it metadata with these file sizes and picks every file. */
async function started(u: Client, n: number, sizes: number[], opts: { pick?: boolean } = {}) {
  const hash = hashOf(n);
  const r = await u.addMagnet(hash, `t${n}`);
  if (r.statusCode !== 201) return { hash, add: r, select: null };
  h.fake.giveMetadata(
    hash,
    `t${n}`,
    sizes.map((size, i) => ({ name: `t${n}/f${i}`, size })),
  );
  await h.tick();
  if (opts.pick === false) return { hash, add: r, select: null };
  const select = await u.post(`/api/torrents/${hash}/select`, { files: sizes.map((_, i) => i) });
  return { hash, add: r, select };
}

const view = async (u: Client, hash: string) => json<{ torrent: TorrentView }>(await u.get(`/api/torrents/${hash}`)).torrent;

describe('quotas', () => {
  it('caps unfinished torrents per session', async () => {
    h = await harness();
    const u = await h.user();
    for (let i = 1; i <= 3; i++) expect((await started(u, i, [1000])).add.statusCode).toBe(201);
    const fourth = await u.addMagnet(hashOf(4));
    expect(fourth.statusCode).toBe(409);
    expect(json(fourth).error).toBe('too_many_active');
    // a finished one no longer counts
    h.fake.complete(hashOf(1));
    await h.tick();
    expect((await u.addMagnet(hashOf(4))).statusCode).toBe(201);
  });

  it('caps unfinished torrents per IP across sessions', async () => {
    h = await harness();
    const a = await h.user('198.51.100.7');
    const b = await h.user('198.51.100.7');
    for (let i = 1; i <= 3; i++) expect((await a.addMagnet(hashOf(i))).statusCode).toBe(201);
    const r = await b.addMagnet(hashOf(9));
    expect(r.statusCode).toBe(409);
    expect(json(r).error).toBe('too_many_active_ip');
    const elsewhere = await h.user('198.51.100.8');
    expect((await elsewhere.addMagnet(hashOf(9))).statusCode).toBe(201);
  });

  it('caps stored data per session and per IP', async () => {
    h = await harness({ MAX_ACTIVE_PER_IP: '10' });
    const u = await h.user('198.51.100.20');
    expect((await started(u, 1, [12 * GB])).select!.statusCode).toBe(200);
    const over = await started(u, 2, [9 * GB]);
    expect(over.select!.statusCode).toBe(409);
    expect(json(over.select!).error).toBe('storage_full');
    // same network, different session
    const other = await h.user('198.51.100.20');
    const ip = await started(other, 3, [9 * GB]);
    expect(json(ip.select!).error).toBe('storage_full_ip');
    expect((await started(u, 4, [8 * GB])).select!.statusCode).toBe(200);
  });

  it('refuses new data when the server-wide cap or the disk is full', async () => {
    h = await harness({ GLOBAL_STORAGE_CAP_GB: '25', MAX_STORAGE_PER_IP_GB: '100' });
    const a = await h.user();
    const b = await h.user();
    expect((await started(a, 1, [15 * GB])).select!.statusCode).toBe(200);
    const full = await started(b, 2, [11 * GB]);
    expect(full.select!.statusCode).toBe(409);
    expect(json(full.select!).error).toBe('server_full');
    // joining an existing torrent needs no new space
    await b.addMagnet(hashOf(1));
    await h.tick();
    const join = await b.post(`/api/torrents/${hashOf(1)}/select`, { files: [0] });
    expect(join.statusCode, join.body).toBe(200);
    // low disk
    h.disk.free = 3 * GB;
    const c = await h.user();
    const disk = await started(c, 3, [2 * GB]);
    expect(json(disk.select!).error).toBe('server_full');
  });
});

describe('cleanup', () => {
  it('deletes finished files after their retention time, by size tier', async () => {
    h = await harness();
    const u = await h.user();
    const small = await started(u, 1, [2 * GB]);
    const big = await started(u, 2, [6 * GB]);
    expect(small.select!.statusCode).toBe(200);
    expect(big.select!.statusCode).toBe(200);
    h.fake.complete(small.hash);
    h.fake.complete(big.hash);
    await h.tick();
    h.clock.now += 6 * HOUR - 1000;
    await h.tick();
    expect(h.fake.torrents.has(big.hash)).toBe(true);
    h.clock.now += 2000;
    await h.tick();
    expect(h.fake.torrents.has(big.hash)).toBe(false);
    expect(h.fake.deleted).toContainEqual({ hash: big.hash, deleteFiles: true });
    expect(h.fake.torrents.has(small.hash)).toBe(true);
    h.clock.now += 18 * HOUR;
    await h.tick();
    expect(h.fake.torrents.has(small.hash)).toBe(false);
    expect(json<{ torrents: TorrentView[] }>(await u.get('/api/torrents')).torrents).toEqual([]);
  });

  it("keeps a shared torrent until the last owner's time is up", async () => {
    h = await harness();
    const a = await h.user();
    const b = await h.user();
    const t = await started(a, 1, [1 * GB]);
    h.fake.complete(t.hash);
    await h.tick();
    h.clock.now += 20 * HOUR;
    await b.addMagnet(t.hash);
    await h.tick();
    await b.post(`/api/torrents/${t.hash}/select`, { files: [0] });
    await h.tick();
    h.clock.now += 5 * HOUR;
    await h.tick();
    expect((await a.get(`/api/torrents/${t.hash}`)).statusCode).toBe(404);
    expect(h.fake.torrents.has(t.hash)).toBe(true);
    expect((await view(b, t.hash)).state).toBe('done');
    h.clock.now += 24 * HOUR;
    await h.tick();
    expect(h.fake.torrents.has(t.hash)).toBe(false);
  });

  it('deletes torrents with no progress for 6 hours, and progress resets the clock', async () => {
    h = await harness();
    const u = await h.user();
    const moving = await started(u, 1, [1000, 1000]);
    const stuck = await started(u, 2, [1000], { pick: false });
    h.clock.now += 5 * HOUR;
    h.fake.complete(moving.hash, [0]);
    await h.tick();
    h.clock.now += 2 * HOUR;
    await h.tick();
    expect(h.fake.torrents.has(stuck.hash)).toBe(false);
    expect(h.fake.torrents.has(moving.hash)).toBe(true);
    h.clock.now += 4 * HOUR + 1000;
    await h.tick();
    expect(h.fake.torrents.has(moving.hash)).toBe(false);
  });

  it('cleans up torrents qBittorrent has but Sayl does not, and the reverse', async () => {
    h = await harness();
    const u = await h.user();
    // an orphan in qbittorrent (e.g. a crash between adding and saving)
    const q = new QbitClient({ baseUrl: h.fake.url, username: 'sayl', password: 'correct horse battery' });
    await q.add({ magnet: `magnet:?xt=urn:btih:${hashOf(0x70)}` }, []);
    h.fake.torrents.get(hashOf(0x70))!.added_on = Math.floor(h.clock.now / 1000) - 60;
    await h.tick();
    expect(h.fake.torrents.has(hashOf(0x70))).toBe(true);
    h.fake.torrents.get(hashOf(0x70))!.added_on = Math.floor(h.clock.now / 1000) - 601;
    await h.tick();
    expect(h.fake.torrents.has(hashOf(0x70))).toBe(false);
    // a database row for a torrent qbittorrent lost
    await u.addMagnet(hashOf(0x71));
    h.fake.torrents.delete(hashOf(0x71));
    h.clock.now += 601_000;
    await h.tick();
    expect(h.db.torrentHashes()).not.toContain(hashOf(0x71));
  });
});

describe('blocklist and bans', () => {
  it('blocks a torrent for everyone and refuses it afterwards', async () => {
    h = await harness();
    const a = await h.user();
    const b = await h.user();
    const t = await started(a, 1, [1000]);
    await b.addMagnet(t.hash);
    const q = new QbitClient({ baseUrl: h.fake.url, username: 'sayl', password: 'correct horse battery' });
    const r = await blockTorrent(h.db, q, t.hash.toUpperCase(), 'dmca notice 123', h.clock.now);
    expect(r).toEqual({ hash: t.hash, owners: 2, deleted: true });
    expect(h.fake.deleted).toContainEqual({ hash: t.hash, deleteFiles: true });
    await h.tick();
    expect((await a.get(`/api/torrents/${t.hash}`)).statusCode).toBe(404);
    for (const c of [a, b, await h.user()]) {
      const again = await c.addMagnet(t.hash);
      expect(again.statusCode).toBe(451);
      expect(json(again).error).toBe('blocked');
    }
    expect(h.db.blocked()).toEqual([{ hash: t.hash, reason: 'dmca notice 123', createdAt: h.clock.now }]);
    expect(unblockTorrent(h.db, `magnet:?xt=urn:btih:${t.hash}`).removed).toBe(true);
    expect((await a.addMagnet(t.hash)).statusCode).toBe(201);
  });

  it('bans an address from the whole API, optionally purging its torrents', async () => {
    h = await harness();
    const bad = await h.user('192.0.2.66');
    const good = await h.user('192.0.2.67');
    await started(bad, 1, [1000]);
    await good.addMagnet(hashOf(1));
    await started(bad, 2, [1000]);
    const q = new QbitClient({ baseUrl: h.fake.url, username: 'sayl', password: 'correct horse battery' });
    expect(await banIp(h.db, q, '192.0.2.66', 'repeat infringer', h.clock.now, true)).toEqual({ ip: '192.0.2.66', purged: 2 });
    // shared torrent stays for the other owner, the other one is deleted
    expect(h.fake.torrents.has(hashOf(1))).toBe(true);
    expect(h.fake.torrents.has(hashOf(2))).toBe(false);
    for (const r of [await bad.get('/api/torrents'), await bad.addMagnet(hashOf(3)), await bad.get('/api/session')]) {
      expect(r.statusCode).toBe(403);
      expect(json(r).error).toBe('banned');
    }
    expect((await h.api.inject({ method: 'POST', url: '/api/session', headers: { origin: ORIGIN, 'cf-connecting-ip': '192.0.2.66' } })).statusCode).toBe(403);
    expect((await good.get('/api/torrents')).statusCode).toBe(200);
    expect(unbanIp(h.db, '192.0.2.66').removed).toBe(true);
    expect((await bad.get('/api/torrents')).statusCode).toBe(200);
  });

  it('lists torrents with owner addresses and validates admin input', async () => {
    h = await harness();
    const u = await h.user('192.0.2.10');
    await started(u, 1, [5 * GB]);
    const q = new QbitClient({ baseUrl: h.fake.url, username: 'sayl', password: 'correct horse battery' });
    const rows = await listTorrents(h.db, q);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hash: hashOf(1), name: 't1', size: 5 * GB, owners: [{ ip: '192.0.2.10' }] });
    expect(() => normaliseHash('nope')).toThrow(/info hash/);
    await expect(banIp(h.db, q, 'not-an-ip', '', 0, false)).rejects.toThrow(/IP address/);
  });
});

describe('access code and captcha', () => {
  const post = (body?: unknown, ip = '203.0.113.9') =>
    h.api.inject({
      method: 'POST',
      url: '/api/session',
      headers: { origin: ORIGIN, 'cf-connecting-ip': ip, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });

  it('needs nothing when both are off', async () => {
    h = await harness();
    expect(json(await h.api.inject({ method: 'GET', url: '/api/session' })).access).toEqual({ code: false, captcha: false });
    expect((await post()).statusCode).toBe(201);
  });

  it('requires the access code when set', async () => {
    h = await harness({ ACCESS_CODE: 'early-bird' });
    expect(json(await h.api.inject({ method: 'GET', url: '/api/session' })).access).toEqual({ code: true, captcha: false });
    for (const body of [undefined, { accessCode: 'wrong' }, { accessCode: '' }, { accessCode: 'early-bird-' }]) {
      const r = await post(body);
      expect(r.statusCode).toBe(403);
      expect(json(r).error).toBe('bad_access_code');
      expect(r.cookies.find((c) => c.name === COOKIE_NAME)).toBeUndefined();
    }
    expect((await post({ accessCode: ' early-bird ' })).statusCode).toBe(201);
  });

  it('requires a valid captcha when Turnstile is configured, checked with the client address', async () => {
    h = await harness({ TURNSTILE_SECRET_KEY: 'secret' });
    expect((await post({ captchaToken: 'bad-token' })).statusCode).toBe(403);
    const ok = await post({ captchaToken: 'good-token' }, '203.0.113.50');
    expect(ok.statusCode).toBe(201);
    expect(h.captcha.calls.at(-1)).toEqual({ token: 'good-token', ip: '203.0.113.50' });
  });

  it('asks for both when both are set', async () => {
    h = await harness({ ACCESS_CODE: 'early-bird', TURNSTILE_SECRET_KEY: 'secret' });
    expect((await post({ accessCode: 'early-bird', captchaToken: 'bad' })).statusCode).toBe(403);
    expect((await post({ accessCode: 'nope', captchaToken: 'good-token' })).statusCode).toBe(403);
    expect((await post({ accessCode: 'early-bird', captchaToken: 'good-token' })).statusCode).toBe(201);
  });
});

describe('rate limits', () => {
  it('limits requests per address per minute', async () => {
    h = await harness({ RATE_LIMIT_PER_MINUTE: '5' });
    const u = await h.user();
    for (let i = 0; i < 5; i++) expect((await u.get('/api/torrents')).statusCode).toBe(200);
    const r = await u.get('/api/torrents');
    expect(r.statusCode).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    h.clock.now += 60_000;
    expect((await u.get('/api/torrents')).statusCode).toBe(200);
    // health checks are never limited
    for (let i = 0; i < 10; i++) expect((await h.api.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('limits new sessions and adds per hour', async () => {
    h = await harness({ SESSIONS_PER_HOUR: '2', ADDS_PER_HOUR: '2', MAX_ACTIVE_PER_USER: '10', MAX_ACTIVE_PER_IP: '10' });
    await h.user('203.0.113.77');
    const u = await h.user('203.0.113.77');
    await expect(h.user('203.0.113.77')).rejects.toThrow(/429/);
    expect((await u.addMagnet(hashOf(1))).statusCode).toBe(201);
    expect((await u.addMagnet(hashOf(2))).statusCode).toBe(201);
    expect((await u.addMagnet(hashOf(3))).statusCode).toBe(429);
  });

  it('counts window hits correctly', () => {
    let t = 0;
    const l = new RateLimiter(2, 1000, () => t);
    expect([l.hit('a'), l.hit('a'), l.hit('a'), l.hit('b')]).toEqual([0, 0, 1, 0]);
    t = 1000;
    expect(l.hit('a')).toBe(0);
  });
});

describe('security headers', () => {
  it('sets protective headers on api responses', async () => {
    h = await harness();
    const r = await h.api.inject({ method: 'GET', url: '/api/session' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
