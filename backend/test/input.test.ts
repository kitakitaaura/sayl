import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { BencodeError, decode, encode } from '../src/bencode.js';
import { fetchTorrentUrl, isPublicAddress } from '../src/remote-torrent.js';
import { InputError, parseMagnet, parseTorrentFile } from '../src/torrent-input.js';
import { bytes, makeTorrent } from './make-torrent.js';

describe('bencode', () => {
  it('round-trips and sorts dictionary keys', () => {
    const v = { b: 1, a: [Buffer.from('x'), -5, { c: Buffer.from('') }] };
    const enc = encode(v);
    expect(enc.toString()).toBe('d1:al1:xi-5ed1:c0:ee1:bi1ee');
    expect(decode(enc)).toEqual({ a: [Buffer.from('x'), -5, { c: Buffer.from('') }], b: 1 });
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'i01e', 'i-0e', 'i1', '5:abc', 'l', 'd1:ae', 'x', 'i1ei2e', 'i99999999999999999999e', 'l'.repeat(100) + 'e'.repeat(100)]) {
      expect(() => decode(Buffer.from(bad)), bad).toThrow(BencodeError);
    }
  });
});

/** RFC 4648 base32 of a hex string, written independently of the code under test. */
function toBase32(hex: string): string {
  const bits = [...Buffer.from(hex, 'hex')].map((b) => b.toString(2).padStart(8, '0')).join('');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

describe('parseMagnet', () => {
  const hex = 'c9e15763f722f23e98a29decdfae341b98d53056';

  it('reads hex and base32 hashes and keeps only safe parts', () => {
    const m = parseMagnet(`magnet:?xt=urn:btih:${hex.toUpperCase()}&dn=Ubuntu%20ISO&tr=udp%3A%2F%2Ft.example%3A80&tr=javascript:x&ws=http://127.0.0.1/&xs=http://evil/`);
    expect(m.infoHash).toBe(hex);
    expect(m.name).toBe('Ubuntu ISO');
    expect(m.trackers).toEqual(['udp://t.example:80']);
    expect(m.magnet).toBe(`magnet:?xt=urn:btih:${hex}&dn=Ubuntu%20ISO&tr=udp%3A%2F%2Ft.example%3A80`);
    expect(parseMagnet(`magnet:?xt=urn:btih:${toBase32(hex)}`).infoHash).toBe(hex);
    expect(parseMagnet(`magnet:?xt=urn:btih:${toBase32(hex).toLowerCase()}`).infoHash).toBe(hex);
  });

  it('accepts hybrid magnets and rejects bad ones', () => {
    expect(parseMagnet(`magnet:?xt=urn:btih:${hex}&xt=urn:btmh:1220${'a'.repeat(64)}`).infoHash).toBe(hex);
    for (const bad of ['magnet:?dn=x', `magnet:?xt=urn:btih:${hex.slice(1)}`, 'http://x', `magnet:?xt=urn:btih:${hex}&dn=${'a'.repeat(9000)}`]) {
      expect(() => parseMagnet(bad), bad.slice(0, 40)).toThrow(InputError);
    }
  });

  it('strips control characters from names', () => {
    expect(parseMagnet(`magnet:?xt=urn:btih:${hex}&dn=a%0D%0Ab%00c`).name).toBe('abc');
  });
});

describe('parseTorrentFile', () => {
  const files = [
    { path: ['a.bin'], data: bytes(40_000, 1) },
    { path: ['sub', 'b.bin'], data: bytes(30_000, 2) },
  ];

  it('computes the info hash and totals', () => {
    const { torrent, infoHash } = makeTorrent('probe', files);
    // the same torrent qBittorrent 5.2.4 reported as 8413579c... in the integration probe
    expect(parseTorrentFile(torrent, 4096 * 1024)).toEqual({ infoHash, name: 'probe', totalSize: 70_000, fileCount: 2 });
    expect(infoHash).toBe('8413579c13fc83abc474c2c110490a93090184b9');
  });

  it('ignores padding files in the totals', () => {
    const t = makeTorrent('pad', files);
    const root = decode(t.torrent) as Record<string, any>;
    root.info.files.splice(1, 0, { length: 100, path: [Buffer.from('.pad'), Buffer.from('100')], attr: Buffer.from('p') });
    root.info.pieces = Buffer.concat([root.info.pieces, Buffer.alloc(20)]);
    expect(parseTorrentFile(encode(root), 1e6)).toMatchObject({ totalSize: 70_000, fileCount: 2 });
  });

  it('rejects size, structure and path problems', () => {
    const { torrent } = makeTorrent('probe', files);
    expect(() => parseTorrentFile(torrent, 100)).toThrow(/at most/);
    expect(() => parseTorrentFile(Buffer.alloc(0), 100)).toThrow(/empty/);
    expect(() => parseTorrentFile(Buffer.from('d4:infod4:name1:xee'), 1e6)).toThrow(InputError);
    for (const p of [['..', 'x'], ['a/b'], ['a\\b'], [''], ['.']]) {
      expect(() => parseTorrentFile(makeTorrent('n', [{ path: p, data: bytes(10, 1) }]).torrent, 1e6), JSON.stringify(p)).toThrow(/unsafe|broken/);
    }
    expect(() => parseTorrentFile(makeTorrent('../up', files).torrent, 1e6)).toThrow(/unsafe/);
    const v2only = encode({ info: { name: Buffer.from('x'), 'meta version': 2, 'piece length': 16384, 'file tree': {} } });
    expect(() => parseTorrentFile(v2only, 1e6)).toThrow(/v2-only/);
  });
});

describe('isPublicAddress', () => {
  it('blocks private, loopback, link-local, metadata and special ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:1.1.1.1', '::ffff:7f00:1', '2001:db8::1', 'not-an-ip']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });
});

describe('fetchTorrentUrl', () => {
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const s = createServer(handler);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => new Promise((r) => s.close(r)) };
  };

  it('refuses private addresses, including via a hostname', async () => {
    for (const url of ['http://127.0.0.1/a.torrent', 'http://[::1]/a.torrent', 'http://169.254.169.254/latest', 'http://localhost/a.torrent']) {
      await expect(fetchTorrentUrl(url, { maxBytes: 1000 }), url).rejects.toThrow(/can't fetch from/);
    }
  });

  it('refuses redirects into private space', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/secret' });
      res.end();
    });
    // the first hop is allowed only because this test opts in; the redirect target is checked again
    await expect(fetchTorrentUrl(`${s.url}/a`, { maxBytes: 1000, allowPrivate: true, maxRedirects: 0 })).rejects.toThrow(/redirects/);
    await s.close();
  });

  it('enforces the size cap and status codes', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200);
        res.end(Buffer.alloc(5000));
      } else if (req.url === '/ok') {
        res.writeHead(200);
        res.end('d4:infoe');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await expect(fetchTorrentUrl(`${s.url}/big`, { maxBytes: 1000, allowPrivate: true })).rejects.toThrow(/at most/);
    await expect(fetchTorrentUrl(`${s.url}/nope`, { maxBytes: 1000, allowPrivate: true })).rejects.toThrow(/404/);
    expect((await fetchTorrentUrl(`${s.url}/ok`, { maxBytes: 1000, allowPrivate: true })).toString()).toBe('d4:infoe');
    await s.close();
  });

  it('rejects non-http schemes and credentials', async () => {
    await expect(fetchTorrentUrl('file:///etc/passwd', { maxBytes: 1000 })).rejects.toThrow(/http/);
    await expect(fetchTorrentUrl('http://u:p@example.com/a.torrent', { maxBytes: 1000 })).rejects.toThrow(/passwords/);
    await expect(fetchTorrentUrl('not a url', { maxBytes: 1000 })).rejects.toThrow(/valid url/);
  });
});
