/**
 * Downloads a .torrent from a URL a user pasted, without letting that URL
 * reach anything private: every address a hostname resolves to (including
 * after redirects) must be public, and the check happens at connect time so
 * DNS rebinding can't slip past it.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { InputError } from './torrent-input.js';

const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked4.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked6.addSubnet(net, bits, 'ipv6');
}

/**
 * True for addresses on the public internet. IPv4 and IPv6 use separate lists
 * so IPv6 rules never match IPv4 addresses. IPv4-mapped IPv6 (::ffff:a.b.c.d)
 * is always refused: real hosts don't resolve to it.
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked4.check(ip, 'ipv4');
  if (family === 6) return !blocked6.check(ip, 'ipv6');
  return false;
}

export interface FetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Tests only: allow loopback and private addresses. */
  allowPrivate?: boolean;
}

const safeLookup =
  (allowPrivate: boolean): LookupFunction =>
  (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as LookupAddress[];
      if (!list.length) return callback(new Error('no addresses'), '', 0);
      if (!allowPrivate && list.some((a) => !isPublicAddress(a.address))) {
        return callback(Object.assign(new Error('private address'), { code: 'SAYL_PRIVATE' }), '', 0);
      }
      if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };

const PRIVATE_MSG = "that url points somewhere sayl can't fetch from";

function getOnce(url: URL, opts: Required<FetchOptions>): Promise<{ redirect: string } | { body: Buffer }> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !opts.allowPrivate && !isPublicAddress(host)) return reject(new InputError(PRIVATE_MSG));
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(
      url,
      {
        lookup: safeLookup(opts.allowPrivate),
        timeout: opts.timeoutMs,
        headers: { 'user-agent': 'Sayl/1.0 (+torrent fetcher)', accept: 'application/x-bittorrent, */*;q=0.5' },
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: res.headers.location });
        }
        if (status !== 200) {
          res.resume();
          return reject(new InputError(`couldn't download that .torrent (the server answered ${status})`));
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          res.destroy();
          return reject(new InputError(`.torrent files can be at most ${Math.floor(opts.maxBytes / 1024)} KB`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            res.destroy();
            reject(new InputError(`.torrent files can be at most ${Math.floor(opts.maxBytes / 1024)} KB`));
          } else chunks.push(c);
        });
        res.on('end', () => resolve({ body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err instanceof InputError) return reject(err);
      if (err.code === 'SAYL_PRIVATE') return reject(new InputError(PRIVATE_MSG));
      reject(new InputError("couldn't download that .torrent url"));
    });
  });
}

export async function fetchTorrentUrl(input: string, options: FetchOptions): Promise<Buffer> {
  const opts: Required<FetchOptions> = { timeoutMs: 15_000, maxRedirects: 3, allowPrivate: false, ...options };
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new InputError("that's not a valid url");
  }
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new InputError('only http and https urls work');
    if (url.username || url.password) throw new InputError("urls with passwords aren't allowed");
    const r = await getOnce(url, opts);
    if ('body' in r) return r.body;
    if (hop >= opts.maxRedirects) throw new InputError('that url redirects too many times');
    url = new URL(r.redirect, url);
  }
}
