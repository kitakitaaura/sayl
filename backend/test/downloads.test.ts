import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentDisposition, parseRange, signLink, verifyLink } from '../src/downloads.js';
import { harness, hashOf, json, type Client, type Harness } from './harness.js';
import { bytes } from './make-torrent.js';

interface Links {
  files: { index: number; path: string; size: number; url: string }[];
  zip: { url: string } | null;
  expiresAt: number;
}

let h: Harness;
let u: Client;
const H = hashOf(0x55);
const A = bytes(50_000, 7);
const B = bytes(1_234, 8);

beforeEach(async () => {
  h = await harness();
  u = await h.user();
  await u.addMagnet(H, 'pack');
  h.fake.giveMetadata(H, 'pack', [
    { name: 'pack/a.bin', size: A.length },
    { name: 'pack/sub/b — ü.txt', size: B.length },
    { name: 'pack/skip.bin', size: 10 },
  ]);
  await h.tick();
  mkdirSync(join(h.dir, 'pack', 'sub'), { recursive: true });
  writeFileSync(join(h.dir, 'pack', 'a.bin'), A);
  writeFileSync(join(h.dir, 'pack', 'sub', 'b — ü.txt'), B);
});
afterEach(async () => {
  await h.close();
});

const path = (url: string) => new URL(url).pathname;
const fetchDl = (url: string, headers: Record<string, string> = {}) => h.dl.inject({ method: 'GET', url: path(url), headers });

/** Reads a stored (uncompressed) zip's entries. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const flags = buf.readUInt16LE(p + 6);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    let size = buf.readUInt32LE(p + 18);
    const start = p + 30 + nameLen + extraLen;
    if (flags & 0x08) {
      // sizes follow in a data descriptor; we know the entries we wrote
      size = name.endsWith('a.bin') ? A.length : B.length;
    }
    const data = buf.subarray(start, start + size);
    out.set(name, method === 0 ? data : inflateRawSync(data));
    p = start + size + (flags & 0x08 ? 16 : 0);
  }
  return out;
}

describe('download links', () => {
  it('hands out no links until files finish', async () => {
    await u.post(`/api/torrents/${H}/select`, { files: [0, 1] });
    const l = json<Links>(await u.get(`/api/torrents/${H}/links`));
    expect(l.files).toEqual([]);
    expect(l.zip).toBeNull();
  });

  it('serves finished files, byte ranges and a zip of the selection', async () => {
    await u.post(`/api/torrents/${H}/select`, { files: [0, 1] });
    h.fake.complete(H);
    await h.tick();
    const l = json<Links>(await u.get(`/api/torrents/${H}/links`));
    expect(l.files.map((f) => f.path)).toEqual(['pack/a.bin', 'pack/sub/b — ü.txt']);
    expect(l.files[0]!.url).toMatch(/^https:\/\/dl\.test\/dl\/[^/]+\/a\.bin$/);
    expect(l.expiresAt).toBe(h.clock.now + 6 * 3600_000);

    const a = await fetchDl(l.files[0]!.url);
    expect(a.statusCode).toBe(200);
    expect(a.rawPayload.equals(A)).toBe(true);
    expect(a.headers['content-length']).toBe(String(A.length));
    expect(a.headers['content-type']).toBe('application/octet-stream');
    expect(a.headers['content-disposition']).toBe(`attachment; filename="a.bin"; filename*=UTF-8''a.bin`);
    expect(a.headers['x-content-type-options']).toBe('nosniff');
    expect(a.headers['accept-ranges']).toBe('bytes');

    const part = await fetchDl(l.files[0]!.url, { range: 'bytes=100-199' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 100-199/${A.length}`);
    expect(part.rawPayload.equals(A.subarray(100, 200))).toBe(true);
    const tail = await fetchDl(l.files[0]!.url, { range: 'bytes=-10' });
    expect(tail.rawPayload.equals(A.subarray(A.length - 10))).toBe(true);
    const bad = await fetchDl(l.files[0]!.url, { range: `bytes=${A.length}-` });
    expect(bad.statusCode).toBe(416);

    const b = await fetchDl(l.files[1]!.url);
    expect(b.rawPayload.equals(B)).toBe(true);
    expect(b.headers['content-disposition']).toContain(`filename*=UTF-8''b%20%E2%80%94%20%C3%BC.txt`);

    const z = await fetchDl(l.zip!.url);
    expect(z.statusCode).toBe(200);
    expect(z.headers['content-type']).toBe('application/zip');
    expect(Number(z.headers['content-length'])).toBe(z.rawPayload.length);
    const entries = unzip(z.rawPayload);
    expect([...entries.keys()]).toEqual(['pack/a.bin', 'pack/sub/b — ü.txt']);
    expect(entries.get('pack/a.bin')!.equals(A)).toBe(true);
    expect(entries.get('pack/sub/b — ü.txt')!.equals(B)).toBe(true);

    const head = await h.dl.inject({ method: 'HEAD', url: path(l.zip!.url) });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(z.headers['content-length']);
  });

  it('offers no zip for a single file', async () => {
    await u.post(`/api/torrents/${H}/select`, { files: [0] });
    h.fake.complete(H);
    await h.tick();
    const l = json<Links>(await u.get(`/api/torrents/${H}/links`));
    expect(l.files).toHaveLength(1);
    expect(l.zip).toBeNull();
  });

  it('refuses tampered, expired, foreign and revoked links', async () => {
    await u.post(`/api/torrents/${H}/select`, { files: [0, 1] });
    h.fake.complete(H);
    await h.tick();
    const l = json<Links>(await u.get(`/api/torrents/${H}/links`));
    const token = path(l.files[0]!.url).split('/')[2]!;
    const [data, sig] = token.split('.');

    // change the file index without re-signing
    const payload = JSON.parse(Buffer.from(data!, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...payload, f: 2 })).toString('base64url');
    expect((await h.dl.inject({ method: 'GET', url: `/dl/${forged}.${sig}/x` })).statusCode).toBe(404);
    // signed with the wrong secret
    const wrong = signLink('x'.repeat(64), { ...payload });
    expect((await h.dl.inject({ method: 'GET', url: `/dl/${wrong}/x` })).statusCode).toBe(404);
    // a file the owner didn't pick, even with a valid signature
    const unpicked = signLink(h.cfg.DOWNLOAD_URL_SECRET, { ...payload, f: 2 });
    expect((await h.dl.inject({ method: 'GET', url: `/dl/${unpicked}/x` })).statusCode).toBe(404);
    // someone else's owner id
    const other = await h.user();
    const foreign = signLink(h.cfg.DOWNLOAD_URL_SECRET, { ...payload, o: other.owner });
    expect((await h.dl.inject({ method: 'GET', url: `/dl/${foreign}/x` })).statusCode).toBe(404);
    // expired
    h.clock.now += 6 * 3600_000 + 1000;
    expect((await fetchDl(l.files[0]!.url)).statusCode).toBe(404);
    h.clock.now -= 6 * 3600_000 + 1000;
    expect((await fetchDl(l.files[0]!.url)).statusCode).toBe(200);
    // removed torrents kill their links
    await u.del(`/api/torrents/${H}`);
    expect((await fetchDl(l.files[0]!.url)).statusCode).toBe(404);
  });

  it("never serves files outside the downloads folder", async () => {
    await u.post(`/api/torrents/${H}/select`, { files: [0, 1] });
    h.fake.complete(H);
    await h.tick();
    const t = h.fake.torrents.get(H)!;
    // a path that climbs out, and a symlink pointing out
    t.files[0]!.name = '../../../../etc/hostname';
    writeFileSync(join(h.dir, 'outside-target'), 'x');
    symlinkSync('/etc/hostname', join(h.dir, 'pack', 'sub', 'b — ü.txt.lnk'));
    t.files[1]!.name = 'pack/sub/b — ü.txt.lnk';
    await h.tick();
    // file list is cached; refresh it the way a recheck would
    t.state = 'checkingDL';
    await h.tick();
    const l = json<Links>(await u.get(`/api/torrents/${H}/links`));
    for (const f of l.files) expect((await fetchDl(f.url)).statusCode).toBe(404);
    expect((await fetchDl(l.zip!.url)).statusCode).toBe(404);
  });

  it("can't fetch links for someone else's torrent", async () => {
    const other = await h.user();
    expect((await other.get(`/api/torrents/${H}/links`)).statusCode).toBe(404);
  });
});

describe('helpers', () => {
  it('signs and verifies tokens', () => {
    const t = signLink('s'.repeat(64), { h: 'a', o: 'b', f: 1, e: 100 });
    expect(verifyLink('s'.repeat(64), t, 99)).toEqual({ h: 'a', o: 'b', f: 1, e: 100 });
    expect(verifyLink('s'.repeat(64), t, 101)).toBeNull();
    expect(verifyLink('s'.repeat(64), t + 'x', 1)).toBeNull();
    expect(verifyLink('s'.repeat(64), 'garbage', 1)).toBeNull();
    expect(verifyLink('s'.repeat(64), `${t}.extra`, 1)).toBeNull();
  });

  it('parses ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-5', 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-1', 100)).toBe('invalid');
    expect(parseRange('bytes=-0', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });

  it('builds safe content-disposition headers', () => {
    expect(contentDisposition('a"b\\c.txt')).toBe(`attachment; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`);
    expect(contentDisposition("it's (1).txt")).toBe(`attachment; filename="it's (1).txt"; filename*=UTF-8''it%27s%20%281%29.txt`);
    expect(contentDisposition('x\r\ny')).not.toMatch(/[\r\n]/);
  });
});
