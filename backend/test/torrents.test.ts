import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileView, TorrentView } from '../src/engine.js';
import { harness, hashOf, json, type Client, type Harness } from './harness.js';
import { bytes, makeTorrent } from './make-torrent.js';

let h: Harness;
let u: Client;
beforeEach(async () => {
  h = await harness();
  u = await h.user();
});
afterEach(async () => {
  await h.close();
});

const view = async (hash: string) => json<{ torrent: TorrentView }>(await u.get(`/api/torrents/${hash}`)).torrent;

describe('adding by magnet', () => {
  const H = hashOf(0x11);

  it('walks through metadata, file picking, download and done', async () => {
    const r = await u.post('/api/torrents', { source: `magnet:?xt=urn:btih:${H}&dn=Debian&ws=http://10.0.0.1/x&tr=udp://tracker.example:1337` });
    expect(r.statusCode).toBe(201);
    expect(json<{ torrent: TorrentView }>(r).torrent).toMatchObject({ hash: H, name: 'Debian', state: 'metadata', progress: 0 });
    const added = h.fake.torrents.get(H)!;
    expect(added.addedWith.stopCondition).toBe('MetadataReceived');
    expect(added.addedWith.urls).toBe(`magnet:?xt=urn:btih:${H}&dn=Debian&tr=${encodeURIComponent('udp://tracker.example:1337')}`);
    expect((await u.get(`/api/torrents/${H}/files`)).statusCode).toBe(409);

    h.fake.giveMetadata(H, 'debian', [
      { name: 'debian/disc.iso', size: 754_000_000 },
      { name: 'debian/SHA256SUMS', size: 1000 },
    ]);
    await h.tick();
    expect((await view(H)).state).toBe('selecting');
    // nothing downloads while the user is still picking
    expect(h.fake.torrents.get(H)!.files.map((f) => f.priority)).toEqual([0, 0]);
    const files = json<{ files: FileView[] }>(await u.get(`/api/torrents/${H}/files`)).files;
    expect(files).toEqual([
      { index: 0, path: 'debian/disc.iso', size: 754_000_000, progress: 0, selected: null },
      { index: 1, path: 'debian/SHA256SUMS', size: 1000, progress: 0, selected: null },
    ]);

    const s = await u.post(`/api/torrents/${H}/select`, { files: [0], sequential: true });
    expect(s.statusCode).toBe(200);
    expect(json<{ torrent: TorrentView }>(s).torrent).toMatchObject({ state: 'downloading', selectedSize: 754_000_000, sequential: true });
    const t = h.fake.torrents.get(H)!;
    expect(t.files.map((f) => f.priority)).toEqual([1, 0]);
    expect(t.seq_dl).toBe(true);
    expect(t.state).toBe('downloading');

    h.fake.complete(H);
    await h.tick();
    const done = await view(H);
    expect(done).toMatchObject({ state: 'done', progress: 1, downloaded: 754_000_000, completedAt: h.clock.now });
    // not seeding: the engine stops it
    expect(h.fake.torrents.get(H)!.state).toBe('stoppedUP');
  });

  it('returns the existing entry when the same user adds it twice', async () => {
    await u.addMagnet(H);
    const again = await u.addMagnet(H);
    expect(again.statusCode).toBe(201);
    expect(json<{ torrents: TorrentView[] }>(await u.get('/api/torrents')).torrents).toHaveLength(1);
  });

  it('rejects things that are not magnets or torrent urls', async () => {
    for (const source of ['hello', 'magnet:?xt=urn:btih:xyz', 'magnet:?dn=nohash', 'ftp://example.com/a.torrent', 'javascript:alert(1)']) {
      const r = await u.post('/api/torrents', { source });
      expect(r.statusCode, source).toBe(400);
    }
    expect((await u.post('/api/torrents', { source: 'magnet:?xt=urn:btmh:1220' + 'a'.repeat(64) })).json().message).toMatch(/v2-only/);
    expect(h.fake.torrents.size).toBe(0);
  });
});

describe('file selection', () => {
  const H = hashOf(0x22);
  beforeEach(async () => {
    await u.addMagnet(H);
    h.fake.giveMetadata(H, 'big', [
      { name: 'big/a.bin', size: 15e9 },
      { name: 'big/b.bin', size: 6e9 },
      { name: 'big/c.txt', size: 100 },
    ]);
    await h.tick();
  });

  it('validates the selection', async () => {
    const cases: [unknown, number, string][] = [
      [{ files: [] }, 400, 'invalid_request'],
      [{ files: [3] }, 400, 'bad_files'],
      [{ files: [-1] }, 400, 'invalid_request'],
      [{ files: [0.5] }, 400, 'invalid_request'],
      [{ files: 'all' }, 400, 'invalid_request'],
      [{ files: [0, 1] }, 413, 'torrent_too_large'],
      [{ files: [0], ratioLimit: 0 }, 400, 'bad_ratio'],
    ];
    for (const [payload, status, code] of cases) {
      const r = await u.post(`/api/torrents/${H}/select`, payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(status);
      expect(json(r).error).toBe(code);
    }
    expect(h.fake.torrents.get(H)!.files.map((f) => f.priority)).toEqual([0, 0, 0]);
  });

  it('allows up to the per-torrent limit and only once', async () => {
    const ok = await u.post(`/api/torrents/${H}/select`, { files: [0, 2, 2] });
    expect(ok.statusCode).toBe(200);
    expect(json<{ torrent: TorrentView }>(ok).torrent.selectedSize).toBe(15e9 + 100);
    const again = await u.post(`/api/torrents/${H}/select`, { files: [1] });
    expect(again.statusCode).toBe(409);
  });
});

describe('controls', () => {
  const H = hashOf(0x33);
  beforeEach(async () => {
    await u.addMagnet(H);
    h.fake.giveMetadata(H, 'x', [{ name: 'x/1', size: 10 }]);
    await h.tick();
  });

  it('needs files picked before pause and resume', async () => {
    expect((await u.post(`/api/torrents/${H}/pause`)).statusCode).toBe(409);
  });

  it('pauses, resumes and rechecks', async () => {
    await u.post(`/api/torrents/${H}/select`, { files: [0] });
    const p = await u.post(`/api/torrents/${H}/pause`);
    expect(json<{ torrent: TorrentView }>(p).torrent.state).toBe('paused');
    expect(h.fake.torrents.get(H)!.state).toBe('stoppedDL');
    const r = await u.post(`/api/torrents/${H}/resume`);
    expect(json<{ torrent: TorrentView }>(r).torrent.state).toBe('downloading');
    expect(h.fake.torrents.get(H)!.state).toBe('downloading');
    const c = await u.post(`/api/torrents/${H}/recheck`);
    expect(json<{ torrent: TorrentView }>(c).torrent.state).toBe('checking');
    expect(h.fake.calls).toContain('/api/v2/torrents/recheck');
  });

  it('removes with the data when it was the only owner', async () => {
    expect((await u.del(`/api/torrents/${H}`)).statusCode).toBe(204);
    expect(h.fake.deleted).toEqual([{ hash: H, deleteFiles: true }]);
    expect((await u.get(`/api/torrents/${H}`)).statusCode).toBe(404);
    expect(h.db.torrentHashes()).toEqual([]);
  });

  it('clears all of the caller’s torrents', async () => {
    await u.addMagnet(hashOf(0x34));
    expect(json(await u.del('/api/torrents')).removed).toBe(2);
    expect(h.fake.torrents.size).toBe(0);
  });
});

describe('seeding', () => {
  const H = hashOf(0x44);
  beforeEach(async () => {
    await u.addMagnet(H);
    h.fake.giveMetadata(H, 's', [{ name: 's/1', size: 1000 }]);
    await h.tick();
  });

  it('seeds after finishing, then stops after the time limit', async () => {
    await u.post(`/api/torrents/${H}/select`, { files: [0], seed: true });
    h.fake.complete(H);
    await h.tick();
    const v = await view(H);
    expect(v.state).toBe('seeding');
    expect(v.seedEndsAt).toBe(h.clock.now + 60 * 60_000);
    expect(h.fake.torrents.get(H)!.state).toBe('stalledUP');
    h.clock.now += 60 * 60_000 + 1;
    await h.tick();
    expect((await view(H)).state).toBe('done');
    expect(h.fake.torrents.get(H)!.state).toBe('stoppedUP');
  });

  it('stops at the ratio limit', async () => {
    await u.post(`/api/torrents/${H}/select`, { files: [0], seed: true, ratioLimit: 0.5 });
    h.fake.complete(H);
    await h.tick();
    expect((await view(H)).state).toBe('seeding');
    h.fake.torrents.get(H)!.ratio = 0.5;
    await h.tick();
    expect((await view(H)).state).toBe('done');
    expect(h.fake.torrents.get(H)!.state).toBe('stoppedUP');
  });

  it('can be stopped early, but only once finished', async () => {
    await u.post(`/api/torrents/${H}/select`, { files: [0], seed: true });
    expect((await u.post(`/api/torrents/${H}/stop-seeding`)).statusCode).toBe(409);
    h.fake.complete(H);
    await h.tick();
    const r = await u.post(`/api/torrents/${H}/stop-seeding`);
    expect(json<{ torrent: TorrentView }>(r).torrent.state).toBe('done');
    expect(h.fake.torrents.get(H)!.state).toBe('stoppedUP');
  });
});

describe('adding a .torrent', () => {
  const files = [
    { path: ['one.bin'], data: bytes(20_000, 1) },
    { path: ['dir', 'two.bin'], data: bytes(9_000, 2) },
  ];

  it('accepts an upload, added stopped until files are picked', async () => {
    const { torrent, infoHash } = makeTorrent('upload', files);
    const r = await u.upload(torrent);
    expect(r.statusCode).toBe(201);
    expect(json<{ torrent: TorrentView }>(r).torrent).toMatchObject({ hash: infoHash, name: 'upload', state: 'selecting', fileCount: 2 });
    expect(h.fake.torrents.get(infoHash)!.addedWith.stopped).toBe('true');
    expect(h.fake.torrents.get(infoHash)!.tags.has(u.tag)).toBe(true);
  });

  it('rejects invalid, oversized and unsafe files', async () => {
    expect((await u.upload(Buffer.from('not a torrent'))).statusCode).toBe(400);
    const huge = Buffer.alloc(4096 * 1024 + 1, 0x61);
    expect((await u.upload(huge)).statusCode).toBe(413);
    const evil = makeTorrent('evil', [{ path: ['..', 'escape.bin'], data: bytes(10, 3) }]);
    const r = await u.upload(evil.torrent);
    expect(r.statusCode).toBe(400);
    expect(json(r).message).toMatch(/unsafe/);
    expect(h.fake.torrents.size).toBe(0);
  });

  it('downloads a .torrent from a url', async () => {
    const { torrent, infoHash } = makeTorrent('remote', files);
    h.remote.set('https://example.org/remote.torrent', torrent);
    const r = await u.post('/api/torrents', { source: 'https://example.org/remote.torrent' });
    expect(r.statusCode).toBe(201);
    expect(json<{ torrent: TorrentView }>(r).torrent.hash).toBe(infoHash);
    const missing = await u.post('/api/torrents', { source: 'https://example.org/missing.torrent' });
    expect(missing.statusCode).toBe(400);
  });
});
