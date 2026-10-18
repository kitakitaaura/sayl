import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { decode, encode } from '../bencode.js';
import { parseMagnet, parseTorrentFile } from '../torrent.js';
import { announceUrls, parseResponse } from '../tracker.js';
import { parsePex } from '../wire.js';

const bytes = (s) => new TextEncoder().encode(s);

test('bencode round trip and info range', () => {
  const v = { announce: 'http://t/announce', info: { length: 5, name: 'a', 'piece length': 16384, pieces: new Uint8Array(20) } };
  const buf = encode(v);
  const { value, end, ranges } = decode(buf);
  assert.equal(end, buf.length);
  assert.equal(value.info.length, 5);
  assert.deepEqual(buf.subarray(...ranges.info), encode(v.info));
  assert.throws(() => decode(bytes('5:ab')));
  assert.throws(() => decode(bytes('i1x')));
});

test('parses magnets with hex and base32 hashes', () => {
  const m = parseMagnet('magnet:?xt=urn:btih:C9E15763F722F23E98A29DECDFAE341B98D53056&dn=x&tr=udp%3A%2F%2Ft%3A1337%2Fannounce');
  assert.equal(m.infoHash, 'c9e15763f722f23e98a29decdfae341b98d53056');
  assert.deepEqual(m.trackers, ['udp://t:1337/announce']);
  const b32 = parseMagnet('magnet:?xt=urn:btih:ZHQVOY7XELZD5GFCTXWN7LRUDOMNKMCW');
  assert.equal(b32.infoHash, 'c9e15763f722f23e98a29decdfae341b98d53056');
  assert.throws(() => parseMagnet('magnet:?xt=urn:btmh:1220abcd'));
});

test('parses a .torrent and hashes the raw info dict', async () => {
  const info = { length: 40000, name: 'f.bin', 'piece length': 16384, pieces: new Uint8Array(60) };
  const t = await parseTorrentFile(encode({ announce: 'http://t/announce', info }));
  assert.equal(t.info.pieceCount, 3);
  assert.equal(t.info.pieceSize(2), 40000 - 2 * 16384);
  assert.match(t.infoHash, /^[0-9a-f]{40}$/);
  await assert.rejects(parseTorrentFile(encode({ info: { ...info, length: 99999 } })));
});

test('udp trackers are tried over http on the same port', () => {
  assert.deepEqual(announceUrls(['udp://tracker.opentrackr.org:1337/announce', 'http://a/announce', 'wss://x', 'udp://noport/announce']), [
    'http://tracker.opentrackr.org:1337/announce',
    'http://a/announce',
  ]);
});

test('parses tracker responses (compact, chunked, failure)', () => {
  const body = encode({ interval: 900, peers: new Uint8Array([1, 2, 3, 4, 0x1a, 0xe1]) });
  const ok = new Uint8Array([...bytes('HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\n'), ...body]);
  assert.deepEqual(parseResponse(ok), { peers: [{ host: '1.2.3.4', port: 6881 }], interval: 900 });
  const hexLen = body.length.toString(16);
  const chunked = new Uint8Array([...bytes(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${hexLen}\r\n`), ...body, ...bytes('\r\n0\r\n\r\n')]);
  assert.equal(parseResponse(chunked).peers.length, 1);
  const fail = new Uint8Array([...bytes('HTTP/1.0 200 OK\r\n\r\n'), ...encode({ 'failure reason': 'unregistered torrent' })]);
  assert.throws(() => parseResponse(fail), /unregistered torrent/);
});

test('parses pex', () => {
  assert.deepEqual(parsePex(encode({ added: new Uint8Array([10, 0, 0, 1, 0, 80]) })), [{ host: '10.0.0.1', port: 80 }]);
});

test('md5 matches the RFC 1321 test vectors', async () => {
  const { md5 } = await import('../md5.js');
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  assert.equal(hex(md5(bytes(''))), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(hex(md5(bytes('abc'))), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(hex(md5(bytes('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))), '57edf4a22be3c955ac49da2e2107b67a');
});

test('stun messages and xor addresses round trip', async () => {
  const { stunMessage, parseStun, encodeXorAddress, decodeXorAddress, withIntegrity } = await import('../turn.js');
  const txid = new Uint8Array(12).fill(9);
  const msg = stunMessage(0x0016, [[0x0012, encodeXorAddress('203.0.113.7', 6881)], [0x0013, bytes('hello')]], txid);
  const parsed = parseStun(msg);
  assert.equal(parsed.type, 0x0016);
  assert.deepEqual(decodeXorAddress(parsed.attrs.get(0x0012), parsed.txid), { host: '203.0.113.7', port: 6881 });
  assert.equal(new TextDecoder().decode(parsed.attrs.get(0x0013)), 'hello');
  const signed = await withIntegrity(msg, new Uint8Array(16));
  assert.equal(signed.length, msg.length + 24);
  assert.equal(parseStun(signed).attrs.get(0x0008).length, 20);
  assert.throws(() => encodeXorAddress('2001:db8::1', 1));
});

test('turn urls: only TCP or TLS ones are usable through the relay', async () => {
  const { parseTurnUrl } = await import('../turn.js');
  assert.deepEqual(parseTurnUrl('turns:standard.relay.metered.ca:443?transport=tcp'), { host: 'standard.relay.metered.ca', port: 443, tls: true });
  assert.deepEqual(parseTurnUrl('turn:standard.relay.metered.ca:80?transport=tcp'), { host: 'standard.relay.metered.ca', port: 80, tls: false });
  assert.equal(parseTurnUrl('turn:standard.relay.metered.ca:80'), null, 'UDP');
  assert.equal(parseTurnUrl('stun:stun.example.org:3478'), null);
});

test('the bundled public trackers are all HTTP(S) announce urls', async () => {
  const { BUNDLED_TRACKERS } = await import('../public-trackers.js');
  assert.ok(BUNDLED_TRACKERS.length >= 20);
  for (const t of BUNDLED_TRACKERS) assert.match(t, /^https?:\/\/[^/]+\/announce$/);
  assert.equal(new Set(BUNDLED_TRACKERS).size, BUNDLED_TRACKERS.length);
});

test('pieces map onto files that sit end to end', async () => {
  const { parseInfo } = await import('../torrent.js');
  const { pieceSegments, piecesForFiles, fileProgress, safePathParts } = await import('../files.js');
  // files of 10, 0, 25 and 5 bytes in pieces of 16: [0..16) [16..32) [32..40)
  const files = [10, 0, 25, 5].map((length, i) => ({ length, path: [new TextEncoder().encode(`f${i}`)] }));
  const info = parseInfo(encode({ name: 'd', 'piece length': 16, pieces: new Uint8Array(60), files }));
  assert.deepEqual(info.files.map((f) => f.offset), [0, 10, 10, 35]);
  assert.deepEqual(pieceSegments(info, 0), [
    { file: 0, fileOffset: 0, pieceOffset: 0, length: 10 },
    { file: 2, fileOffset: 0, pieceOffset: 10, length: 6 },
  ]);
  assert.deepEqual(pieceSegments(info, 2), [
    { file: 2, fileOffset: 22, pieceOffset: 0, length: 3 },
    { file: 3, fileOffset: 0, pieceOffset: 3, length: 5 },
  ]);
  assert.deepEqual([...piecesForFiles(info, [0])], [1, 0, 0]);
  assert.deepEqual([...piecesForFiles(info, [2])], [1, 1, 1]);
  assert.deepEqual([...piecesForFiles(info, [3])], [0, 0, 1]);
  assert.deepEqual([...piecesForFiles(info, [1])], [0, 0, 0], 'an empty file needs no pieces');
  assert.deepEqual(fileProgress(info, new Uint8Array([1, 0, 1])), [10, 0, 9, 5]);
  assert.deepEqual(safePathParts('../a//./b\\c/..'), ['a', 'b', 'c']);
  assert.deepEqual(safePathParts('x:y?.txt'), ['x_y_.txt']);
  assert.deepEqual(safePathParts('..'), ['file']);
});

test("TURN logins come from the relay, or from the website when the relay has none", async () => {
  const { fetchTurnServers, TurnError } = await import('../turn.js');
  const login = (url) => ({ url, username: 'u', credential: 'p' });
  const answers = new Map();
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    asked.push(u);
    const [status, body] = answers.get(new URL(u).origin + new URL(u).pathname) ?? [404, {}];
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  const relay = { url: 'https://relay.test', token: 't' };
  const opts = { fallback: 'https://site.test/api/turn' };
  try {
    answers.set('https://relay.test/turn-credentials', [200, { servers: [login('turn:own.test:80?transport=tcp'), login('turns:own.test:443?transport=tcp')] }]);
    answers.set('https://site.test/api/turn', [200, { servers: [login('turns:site.test:443?transport=tcp')] }]);
    let s = await fetchTurnServers(relay, opts);
    assert.equal(s[0].url, 'turns:own.test:443?transport=tcp', "the relay's own login comes first, TLS on 443 first");
    assert.equal(asked.length, 1, 'the website is not asked when the relay has a login');
    assert.equal(new URL(asked[0]).searchParams.get('token'), 't');

    answers.set('https://relay.test/turn-credentials', [200, { servers: [], error: 'the DHT is not set up here' }]);
    s = await fetchTurnServers(relay, opts);
    assert.deepEqual(s.map((x) => x.url), ['turns:site.test:443?transport=tcp'], "the website's login when the relay has none");

    answers.set('https://relay.test/turn-credentials', [404, {}]); // an older relay without /turn-credentials
    assert.equal((await fetchTurnServers(relay, opts))[0].url, 'turns:site.test:443?transport=tcp');

    answers.set('https://relay.test/turn-credentials', [403, { error: 'bad token' }]);
    await assert.rejects(fetchTurnServers(relay, opts), (e) => e instanceof TurnError && e.code === 403, 'a refused token is not papered over');

    answers.set('https://relay.test/turn-credentials', [200, { servers: [] }]);
    answers.set('https://site.test/api/turn', [503, { servers: [], error: 'the TURN provider refused (402)' }]);
    await assert.rejects(fetchTurnServers(relay, opts), (e) => e.code === 'off' && /refused/.test(e.message), 'neither: off, so the DHT rests');
    answers.delete('https://site.test/api/turn'); // a site without the Worker
    await assert.rejects(fetchTurnServers(relay, opts), (e) => e.code === 'off');
    await assert.rejects(fetchTurnServers(relay), (e) => e.code === 'off', 'no fallback: as before');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('makes torrents that parse back and whose pieces check out', async () => {
  const { createTorrent, pickPieceLength } = await import('../create.js');
  const { sha1: hash } = await import('../torrent.js');
  const { pieceSegments } = await import('../files.js');
  assert.equal(pickPieceLength(1), 16 * 1024);
  assert.equal(pickPieceLength(1e9), 1024 * 1024);
  assert.equal(pickPieceLength(1e13), 16 * 1024 * 1024);

  const bytes = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
  const a = bytes(40_000, 1);
  const c = bytes(70_001, 3);
  const files = [
    { path: ['a.bin'], blob: new Blob([a]) },
    { path: ['sub', 'empty.txt'], blob: new Blob([]) },
    { path: ['sub', 'c.bin'], blob: new Blob([c]) },
  ];
  let lastProgress = null;
  const t = await createTorrent({ name: 'my share', files, trackers: ['http://t1.test/announce', 'http://t2.test/announce', 'http://t1.test/announce'], onprogress: (d, n) => (lastProgress = [d, n]) });
  assert.deepEqual(lastProgress, [110_001, 110_001]);
  assert.equal(t.info.name, 'my share');
  assert.deepEqual(t.info.files.map((f) => [f.path, f.length]), [['a.bin', 40_000], ['sub/empty.txt', 0], ['sub/c.bin', 70_001]]);
  assert.equal(t.info.pieceLength, 16 * 1024);
  assert.equal(t.info.pieceCount, Math.ceil(110_001 / 16384));
  const parsed = await parseTorrentFile(t.torrent);
  assert.equal(parsed.infoHash, t.infoHash);
  assert.deepEqual(parsed.trackers, ['http://t1.test/announce', 'http://t2.test/announce']);
  const all = new Uint8Array(110_001);
  all.set(a, 0);
  all.set(c, 40_000);
  for (let p = 0; p < t.info.pieceCount; p++) {
    const start = p * t.info.pieceLength;
    assert.deepEqual(await hash(all.subarray(start, start + t.info.pieceSize(p))), t.info.pieceHash(p), `piece ${p}`);
  }
  assert.ok(pieceSegments(t.info, 2).some((s) => s.file === 2), 'the empty file is skipped over');
  const m = parseMagnet(t.magnet);
  assert.equal(m.infoHash, t.infoHash);
  assert.equal(m.name, 'my share');
  assert.deepEqual(m.trackers, ['http://t1.test/announce', 'http://t2.test/announce']);

  const one = await createTorrent({ name: 'ignored', files: [{ path: ['song.flac'], blob: new Blob([a]) }] });
  assert.equal(one.info.name, 'song.flac');
  assert.deepEqual(one.info.files, [{ path: 'song.flac', length: 40_000, offset: 0 }]);
  assert.equal((await parseTorrentFile(one.torrent)).infoHash, one.infoHash);

  await assert.rejects(createTorrent({ name: 'x', files: [{ path: ['e'], blob: new Blob([]) }] }), /empty/);
  await assert.rejects(createTorrent({ name: 'x', files: [{ path: ['..'], blob: new Blob([a]) }] }), /unusable/);
  await assert.rejects(createTorrent({ name: 'x', files: [{ path: ['a'], blob: new Blob([a]) }, { path: ['a'], blob: new Blob([c]) }] }), /both called/);
  await assert.rejects(createTorrent({ name: ' ', files }), /name/);
});

test('zips made from files open in a standard unzipper, with and without ZIP64', async () => {
  const { makeZip, crc32 } = await import('../zip.js');
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const a = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) & 255);
  const b = new TextEncoder().encode('hello, zip');
  const files = [
    { path: 'pack/a.bin', blob: new Blob([a]) },
    { path: 'pack/sub/b é.txt', blob: new Blob([b]) },
    { path: 'pack/empty.txt', blob: new Blob([]) },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'sayl-zip-'));
  try {
    for (const forceZip64 of [false, true]) {
      let progress = null;
      const zip = await makeZip(files, { forceZip64, onprogress: (r, t) => (progress = [r, t]) });
      assert.deepEqual(progress, [300_010, 300_010]);
      const file = join(dir, `t${forceZip64}.zip`);
      writeFileSync(file, new Uint8Array(await zip.arrayBuffer()));
      // python's zipfile checks every CRC and reads ZIP64 records
      const out = execFileSync('python3', ['-I', '-c', `
import zipfile, sys, hashlib, json
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None
print(json.dumps({i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()}))
`, file]).toString();
      const got = JSON.parse(out);
      const sha = (u8) => createHash('sha256').update(u8).digest('hex');
      assert.deepEqual(got, { 'pack/a.bin': sha(a), 'pack/sub/b é.txt': sha(b), 'pack/empty.txt': sha(new Uint8Array(0)) }, `zip64 ${forceZip64}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('speed limits let through about their rate', async () => {
  const { RateLimiter } = await import('../limiter.js');
  const free = new RateLimiter(0);
  assert.ok(free.take(1e9), 'no limit');
  const lim = new RateLimiter(256 * 1024); // 256 KiB/s, so a 256 KiB burst
  let taken = 0;
  while (lim.take(16 * 1024)) taken += 16 * 1024;
  assert.equal(taken, 256 * 1024, 'one second\'s worth at once, no more');
  const start = Date.now();
  for (let i = 0; i < 10; i++) await lim.wait(16 * 1024); // 160 KiB more: about 0.63 s
  const secs = (Date.now() - start) / 1000;
  assert.ok(secs > 0.5 && secs < 1.1, `took ${secs}s`);
});
