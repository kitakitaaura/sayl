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

test('md5 matches the RFC 1321 test vectors', async () => {
  const { md5 } = await import('../public/client/md5.js');
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  assert.equal(hex(md5(bytes(''))), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(hex(md5(bytes('abc'))), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(hex(md5(bytes('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))), '57edf4a22be3c955ac49da2e2107b67a');
});

test('stun messages and xor addresses round trip', async () => {
  const { stunMessage, parseStun, encodeXorAddress, decodeXorAddress, withIntegrity } = await import('../public/client/turn.js');
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

test('relay policy: turn', async () => {
  const { isTurnAllocate, turnHosts } = await import('../worker/policy.js');
  const allocate = new Uint8Array([0, 3, 0, 8, 0x21, 0x12, 0xa4, 0x42, ...new Uint8Array(12), 0, 0x19, 0, 4, 17, 0, 0, 0]);
  assert.ok(isTurnAllocate(allocate));
  assert.ok(!isTurnAllocate(allocate.slice(0, 24)), 'truncated');
  const binding = allocate.slice();
  binding[1] = 1;
  assert.ok(!isTurnAllocate(binding), 'a binding request is not an allocate');
  assert.deepEqual([...turnHosts(undefined)], ['turn.cloudflare.com']);
  assert.deepEqual([...turnHosts(' A.example , b.example ')], ['a.example', 'b.example']);
});
