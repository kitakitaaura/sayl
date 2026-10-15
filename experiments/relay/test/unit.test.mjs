import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode, encode } from '../public/client/bencode.js';
import { parseMagnet, parseTorrentFile } from '../public/client/torrent.js';
import { announceUrls, parseResponse } from '../public/client/tracker.js';
import { parsePex } from '../public/client/wire.js';
import { isAnnounceRequest, parseTarget, startsWithBtHandshake } from '../worker/policy.js';

const bytes = (s) => new TextEncoder().encode(s);
const target = (q, allowPrivate = false) => parseTarget(new URLSearchParams(q), { allowPrivate });

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

test('relay policy: handshakes and announces', () => {
  assert.ok(startsWithBtHandshake(new Uint8Array([19, ...bytes('BitTorrent protocol'), 0])));
  assert.ok(!startsWithBtHandshake(bytes('GET / HTTP/1.1')));
  assert.ok(isAnnounceRequest(bytes('GET /announce?info_hash=%01%02&port=1 HTTP/1.0\r\nHost: t\r\n\r\n')));
  assert.ok(isAnnounceRequest(bytes('GET /abc123/announce.php?x=1&info_hash=%01 HTTP/1.1\r\nHost: t\r\n\r\n')));
  assert.ok(!isAnnounceRequest(bytes('GET /announce HTTP/1.0\r\nHost: t\r\n\r\n')), 'no info_hash');
  assert.ok(!isAnnounceRequest(bytes('POST /announce?info_hash=1 HTTP/1.0\r\n\r\n')));
  assert.ok(!isAnnounceRequest(bytes('GET /announce?info_hash=1 HTTP/1.0\r\nHost: t\r\n\r\nGET /other HTTP/1.0\r\n\r\n')), 'smuggled second request');
  assert.ok(!isAnnounceRequest(bytes('GET /announce?info_hash=1 HTTP/1.0\r\nHost: t\r\n')), 'unterminated');
});

test('relay policy: targets', () => {
  assert.deepEqual(target('host=1.2.3.4&port=6881'), { host: '1.2.3.4', port: 6881, tls: false });
  assert.deepEqual(target('host=tracker.example.org&port=443&tls=1'), { host: 'tracker.example.org', port: 443, tls: true });
  assert.deepEqual(target('host=[2001:db8::1]&port=6881'), { host: '2001:db8::1', port: 6881, tls: false });
  for (const q of ['host=10.1.2.3&port=1', 'host=127.0.0.1&port=1', 'host=192.168.1.1&port=1', 'host=172.20.0.1&port=1', 'host=169.254.169.254&port=80',
    'host=100.64.0.1&port=1', 'host=::1&port=1', 'host=fd00::1&port=1', 'host=fe80::1&port=1', 'host=::ffff:10.0.0.1&port=1', 'host=localhost&port=1', 'host=x.internal&port=1'])
    assert.equal(target(q).error, 'private address', q);
  assert.equal(target('host=10.1.2.3&port=1', true).host, '10.1.2.3');
  assert.equal(target('host=1.2.3.4&port=25').error, 'port not allowed');
  assert.equal(target('host=1.2.3.4&port=0').error, 'bad port');
  assert.equal(target('host=1.2.3.999&port=1').error, 'bad host');
  assert.equal(target('host=a b&port=1').error, 'bad host');
  assert.equal(target('port=1').error, 'missing host');
});
