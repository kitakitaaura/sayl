/**
 * Signed download links and the file server behind the download domain.
 *
 * A link is /dl/<token>/<filename>. The token names the torrent, the owner, the
 * file (or the whole selection as a zip) and an expiry, signed with
 * DOWNLOAD_URL_SECRET. On every request the owner must still own the torrent
 * and the file must be finished, so removing a torrent kills its links.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import yazl from 'yazl';
import type { Config } from './config.js';
import type { Engine } from './engine.js';
import { ApiError } from './errors.js';

export interface LinkPayload {
  /** info hash */
  h: string;
  /** owner id */
  o: string;
  /** file index, or -1 for a zip of every finished file the owner picked */
  f: number;
  /** expiry, unix seconds */
  e: number;
}

const LINK_TTL_SECONDS = 6 * 60 * 60;

const sign = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url');

export function signLink(secret: string, p: LinkPayload): string {
  const data = Buffer.from(JSON.stringify(p)).toString('base64url');
  return `${data}.${sign(secret, data)}`;
}

export function verifyLink(secret: string, token: string, nowSeconds: number): LinkPayload | null {
  const [data, sig, extra] = token.split('.');
  if (!data || !sig || extra !== undefined) return null;
  const want = Buffer.from(sign(secret, data));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as LinkPayload;
    if (typeof p.h !== 'string' || typeof p.o !== 'string' || !Number.isInteger(p.f) || !Number.isInteger(p.e)) return null;
    if (p.e < nowSeconds) return null;
    return p;
  } catch {
    return null;
  }
}

export function publicDlBase(cfg: Config): string {
  return (cfg.DL_PUBLIC_URL || `https://${cfg.DL_DOMAIN}`).replace(/\/+$/, '');
}

/** Builds the links the API hands out for an owner's finished files. */
export function makeLinks(cfg: Config, engine: Engine, owner: string, hash: string, nowMs: number) {
  const { view, files } = engine.completedFiles(owner, hash);
  const e = Math.floor(nowMs / 1000) + LINK_TTL_SECONDS;
  const base = publicDlBase(cfg);
  const url = (f: number, name: string) =>
    `${base}/dl/${signLink(cfg.DOWNLOAD_URL_SECRET, { h: hash, o: owner, f, e })}/${encodeURIComponent(name)}`;
  return {
    expiresAt: e * 1000,
    files: files.map((f) => ({ index: f.index, path: f.path, size: f.size, url: url(f.index, basename(f.path)) })),
    zip: files.length > 1 ? { size: null, url: url(-1, `${view.name}.zip`) } : null,
  };
}

/** Resolves a qBittorrent file path inside the downloads folder, refusing anything that escapes it. */
export async function safePath(root: string, relative: string): Promise<string | null> {
  const rootReal = await realpath(root).catch(() => null);
  if (!rootReal) return null;
  const candidate = resolve(rootReal, relative);
  if (!candidate.startsWith(rootReal + sep)) return null;
  const real = await realpath(candidate).catch(() => null);
  if (!real || !real.startsWith(rootReal + sep)) return null;
  const s = await stat(real).catch(() => null);
  return s?.isFile() ? real : null;
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Parses a single "bytes=" range. Returns null for no/unsupported range, 'invalid' for unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multiple ranges or other units: send the whole file
  const [, a, b] = m;
  if (!a && !b) return 'invalid';
  let start: number;
  let end: number;
  if (!a) {
    const suffix = Number(b);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b ? Math.min(Number(b), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

function securityHeaders(reply: FastifyReply): void {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('content-security-policy', "default-src 'none'; sandbox");
  reply.header('referrer-policy', 'no-referrer');
  reply.header('cache-control', 'private, no-store');
}

export function registerDownloadRoutes(app: FastifyInstance, cfg: Config, engine: Engine, now: () => number = Date.now): void {
  const deny = () => new ApiError(404, 'not_found', 'this link is invalid or expired');

  app.route({
    method: ['GET', 'HEAD'],
    url: '/dl/:token/:name',
    handler: async (req, reply) => {
      const { token } = req.params as { token: string; name: string };
      const p = verifyLink(cfg.DOWNLOAD_URL_SECRET, token, Math.floor(now() / 1000));
      if (!p) throw deny();
      let finished;
      try {
        finished = engine.completedFiles(p.o, p.h);
      } catch {
        throw deny();
      }
      securityHeaders(reply);

      if (p.f === -1) {
        if (finished.files.length < 2) throw deny();
        const entries: { path: string; real: string; size: number }[] = [];
        for (const f of finished.files) {
          const real = await safePath(cfg.DOWNLOADS_DIR, f.path);
          if (!real) throw deny();
          entries.push({ path: f.path, real, size: (await stat(real)).size });
        }
        const zip = new yazl.ZipFile();
        for (const e of entries) {
          zip.addReadStreamLazy(e.path, { size: e.size, compress: false }, (cb) => cb(null, createReadStream(e.real)));
        }
        // yazl passes the final size (or -1) to this callback; its type definitions omit the argument
        const size = await new Promise<number>((done) => zip.end(undefined, ((n: number) => done(n)) as unknown as () => void));
        reply.header('content-type', 'application/zip');
        reply.header('content-disposition', contentDisposition(`${finished.view.name}.zip`));
        if (size >= 0) reply.header('content-length', size);
        // the read streams are lazy, so a HEAD request never touches the files
        if (req.method === 'HEAD') return reply.send();
        return reply.send(zip.outputStream);
      }

      const file = finished.files.find((f) => f.index === p.f);
      if (!file) throw deny();
      const real = await safePath(cfg.DOWNLOADS_DIR, file.path);
      if (!real) throw deny();
      const size = (await stat(real)).size;
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-disposition', contentDisposition(basename(file.path)));
      reply.header('accept-ranges', 'bytes');
      const range = parseRange(req.headers.range, size);
      if (range === 'invalid') {
        reply.header('content-range', `bytes */${size}`);
        return reply.code(416).send();
      }
      if (range) {
        reply.code(206);
        reply.header('content-range', `bytes ${range.start}-${range.end}/${size}`);
        reply.header('content-length', range.end - range.start + 1);
        if (req.method === 'HEAD') return reply.send();
        return reply.send(createReadStream(real, { start: range.start, end: range.end }));
      }
      reply.header('content-length', size);
      if (req.method === 'HEAD') return reply.send();
      return reply.send(createReadStream(real));
    },
  });
}
