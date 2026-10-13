/**
 * Users must never see or touch each other's torrents. Every route that takes
 * a hash answers 404 for someone else's torrent (no hint that it exists), and
 * nothing about the owner's torrent changes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TorrentView } from '../src/engine.js';
import { harness, hashOf, json, type Client, type Harness } from './harness.js';

let h: Harness;
let alice: Client;
let bob: Client;
const H = hashOf(0xa1);

const files = [
  { name: 'show/ep1.mkv', size: 1_000_000 },
  { name: 'show/ep2.mkv', size: 2_000_000 },
  { name: 'show/notes.txt', size: 1_000 },
];

beforeEach(async () => {
  h = await harness();
  alice = await h.user();
  bob = await h.user();
  expect((await alice.addMagnet(H, 'show')).statusCode).toBe(201);
  h.fake.giveMetadata(H, 'show', files);
  await h.tick();
  expect((await alice.post(`/api/torrents/${H}/select`, { files: [0] })).statusCode).toBe(200);
  await h.tick();
});
afterEach(async () => {
  await h.close();
});

const snapshot = () => {
  const t = h.fake.torrents.get(H)!;
  return { state: t.state, tags: [...t.tags].sort(), prios: t.files.map((f) => f.priority), seq: t.seq_dl };
};

describe('isolation between sessions', () => {
  it("doesn't list another user's torrents", async () => {
    expect(json<{ torrents: TorrentView[] }>(await alice.get('/api/torrents')).torrents.map((t) => t.hash)).toEqual([H]);
    expect(json<{ torrents: TorrentView[] }>(await bob.get('/api/torrents')).torrents).toEqual([]);
  });

  it("answers 404 for every route on another user's torrent and changes nothing", async () => {
    const before = snapshot();
    const attempts = [
      bob.get(`/api/torrents/${H}`),
      bob.get(`/api/torrents/${H}/files`),
      bob.get(`/api/torrents/${H}/links`),
      bob.post(`/api/torrents/${H}/select`, { files: [1] }),
      bob.post(`/api/torrents/${H}/pause`),
      bob.post(`/api/torrents/${H}/resume`),
      bob.post(`/api/torrents/${H}/recheck`),
      bob.post(`/api/torrents/${H}/stop-seeding`),
      bob.del(`/api/torrents/${H}`),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.statusCode).toBe(404);
      expect(json(r).error).toBe('not_found');
    }
    expect(snapshot()).toEqual(before);
    expect(h.fake.deleted).toEqual([]);
    expect(json<{ torrents: TorrentView[] }>(await alice.get('/api/torrents')).torrents[0]!.state).toBe('downloading');
  });

  it("answers an unknown hash and another user's hash the same way", async () => {
    const theirs = await bob.get(`/api/torrents/${H}`);
    const unknown = await bob.get(`/api/torrents/${hashOf(0xee)}`);
    expect(theirs.statusCode).toBe(unknown.statusCode);
    expect(theirs.json()).toEqual(unknown.json());
  });

  it("clearing everything only clears the caller's torrents", async () => {
    expect(json(await bob.del('/api/torrents')).removed).toBe(0);
    expect(h.fake.torrents.has(H)).toBe(true);
    expect(json<{ torrents: TorrentView[] }>(await alice.get('/api/torrents')).torrents).toHaveLength(1);
  });

  it('rejects malformed and uppercase hashes as not found', async () => {
    for (const bad of [H.toUpperCase(), H.slice(1), `${H}0`, '../../etc/passwd', '%2e%2e']) {
      expect((await alice.get(`/api/torrents/${bad}`)).statusCode).toBe(404);
    }
  });

  it('hides a torrent whose qBittorrent tag disagrees with the database', async () => {
    h.fake.torrents.get(H)!.tags.delete(alice.tag);
    await h.tick();
    expect(json<{ torrents: TorrentView[] }>(await alice.get('/api/torrents')).torrents).toEqual([]);
    expect((await alice.get(`/api/torrents/${H}`)).statusCode).toBe(404);
    expect((await alice.post(`/api/torrents/${H}/pause`)).statusCode).toBe(404);
  });

  it('tags each torrent with its owner in qBittorrent', async () => {
    expect([...h.fake.torrents.get(H)!.tags]).toEqual([alice.tag]);
    expect(alice.tag).toMatch(/^owner-[A-Za-z0-9_-]{22}$/);
    expect(alice.tag).not.toBe(bob.tag);
    // the cookie itself is never written to qBittorrent
    expect(alice.tag).not.toContain(alice.cookie.split('=')[1]!.split('.')[0]!);
  });

  it("doesn't leak another user's torrents through live updates", async () => {
    expect(h.engine.list(bob.owner)).toEqual([]);
    expect(h.engine.list(alice.owner)).toHaveLength(1);
  });
});

describe('joining a torrent someone else already has', () => {
  it('lets the new owner act on it straight away, before the next poll', async () => {
    expect((await bob.addMagnet(H, 'show')).statusCode).toBe(201);
    expect((await bob.get(`/api/torrents/${H}`)).statusCode).toBe(200);
    expect((await bob.del(`/api/torrents/${H}`)).statusCode).toBe(204);
    expect(h.fake.torrents.has(H)).toBe(true);
  });
});

describe('two users adding the same torrent', () => {
  beforeEach(async () => {
    expect((await bob.addMagnet(H, 'show')).statusCode).toBe(201);
    await h.tick();
  });

  it('shares one copy in qBittorrent but keeps separate views', async () => {
    expect(h.fake.torrents.size).toBe(1);
    expect([...h.fake.torrents.get(H)!.tags].sort()).toEqual([alice.tag, bob.tag].sort());
    const a = json<{ torrent: TorrentView }>(await alice.get(`/api/torrents/${H}`)).torrent;
    const b = json<{ torrent: TorrentView }>(await bob.get(`/api/torrents/${H}`)).torrent;
    expect(a.state).toBe('downloading');
    expect(b.state).toBe('selecting');
    const bFiles = json<{ files: { selected: boolean | null }[] }>(await bob.get(`/api/torrents/${H}/files`)).files;
    expect(bFiles.map((f) => f.selected)).toEqual([null, null, null]);
  });

  it('downloads the union of both selections', async () => {
    await bob.post(`/api/torrents/${H}/select`, { files: [1] });
    expect(h.fake.torrents.get(H)!.files.map((f) => f.priority)).toEqual([1, 1, 0]);
    const aFiles = json<{ files: { selected: boolean }[] }>(await alice.get(`/api/torrents/${H}/files`)).files;
    expect(aFiles.map((f) => f.selected)).toEqual([true, false, false]);
  });

  it("one user's pause doesn't stop the other's download", async () => {
    await bob.post(`/api/torrents/${H}/select`, { files: [1] });
    await alice.post(`/api/torrents/${H}/pause`);
    await h.tick();
    expect(h.fake.torrents.get(H)!.state).toBe('downloading');
    expect(json<{ torrent: TorrentView }>(await alice.get(`/api/torrents/${H}`)).torrent.state).toBe('paused');
    expect(json<{ torrent: TorrentView }>(await bob.get(`/api/torrents/${H}`)).torrent.state).toBe('downloading');
    await bob.post(`/api/torrents/${H}/pause`);
    expect(h.fake.torrents.get(H)!.state).toBe('stoppedDL');
  });

  it("removing keeps the data while someone else still owns it", async () => {
    await bob.post(`/api/torrents/${H}/select`, { files: [1] });
    expect((await alice.del(`/api/torrents/${H}`)).statusCode).toBe(204);
    expect(h.fake.torrents.has(H)).toBe(true);
    expect([...h.fake.torrents.get(H)!.tags]).toEqual([bob.tag]);
    expect(h.fake.torrents.get(H)!.files.map((f) => f.priority)).toEqual([0, 1, 0]);
    expect((await alice.get(`/api/torrents/${H}`)).statusCode).toBe(404);
    expect((await bob.del(`/api/torrents/${H}`)).statusCode).toBe(204);
    expect(h.fake.torrents.has(H)).toBe(false);
    expect(h.fake.deleted).toEqual([{ hash: H, deleteFiles: true }]);
  });
});
