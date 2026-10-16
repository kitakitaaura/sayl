import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAnnounceRequest, parseTarget, startsWithBtHandshake } from '../worker/policy.js';

const bytes = (s) => new TextEncoder().encode(s);
const target = (q, allowPrivate = false) => parseTarget(new URLSearchParams(q), { allowPrivate });

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
  const { isTurnHost } = await import('../worker/policy.js');
  const hosts = turnHosts('turn.example.org,*.relay.example.com');
  assert.ok(isTurnHost('turn.example.org', hosts));
  assert.ok(isTurnHost('global.relay.example.com', hosts));
  assert.ok(!isTurnHost('relay.example.com', hosts), 'the bare parent is not a subdomain');
  assert.ok(!isTurnHost('evilrelay.example.com', hosts));
  assert.ok(!isTurnHost('x.relay.example.com.evil.net', hosts));
});
