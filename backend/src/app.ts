import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config.js';
import { makeLinks, registerDownloadRoutes } from './downloads.js';
import type { Engine, NewTorrent } from './engine.js';
import { ApiError, badRequest, forbidden } from './errors.js';
import { QbitError } from './qbit.js';
import { fetchTorrentUrl } from './remote-torrent.js';
import { endSession, readSession, requireOwner, startSession } from './session.js';
import { InputError, parseMagnet, parseTorrentFile } from './torrent-input.js';

/** Whether the backend has reached qBittorrent and verified its settings. */
export interface EngineState {
  ready: boolean;
  error: string | null;
}

export interface ApiDeps {
  engine: Engine;
  now?: () => number;
  /** Downloads a .torrent from a pasted url. Swappable for tests. */
  fetchTorrent?: (url: string) => Promise<Buffer>;
}

function logger(cfg: Config) {
  return { level: cfg.LOG_LEVEL };
}

function errorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof InputError) return reply.code(400).send({ error: 'invalid_input', message: err.message });
    if (err instanceof QbitError) {
      req.log.error({ err: err.message }, 'qbittorrent request failed');
      return reply.code(502).send({ error: 'engine_unavailable', message: 'the torrent engine is unavailable. try again in a minute.' });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as FastifyError).code ?? 'bad_request', message: err.message.toLowerCase() });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'something went wrong on our side' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'not found' }));
}

export function limits(cfg: Config) {
  return {
    maxActive: cfg.MAX_ACTIVE_PER_USER,
    maxStorageGb: cfg.MAX_STORAGE_PER_USER_GB,
    maxTorrentGb: cfg.MAX_TORRENT_SIZE_GB,
    maxTorrentFileKb: cfg.MAX_TORRENT_FILE_KB,
    retention: cfg.RETENTION_TIERS.map((t) => ({ maxGb: t.maxBytes / 1e9, hours: t.hours })),
    seedMaxMinutes: cfg.SEED_MAX_MINUTES,
    defaultRatioLimit: cfg.DEFAULT_RATIO_LIMIT,
  };
}

const hashParam = z.object({ hash: z.string() });
const addBody = z.object({ source: z.string().trim().min(1).max(8192) });
const selectBody = z.object({
  files: z.array(z.number().int().min(0)).min(1).max(100_000),
  seed: z.boolean().optional(),
  sequential: z.boolean().optional(),
  ratioLimit: z.number().optional(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw badRequest('that request is invalid', 'invalid_request');
  return r.data;
}

/** The client's address. The API is only reachable through the Cloudflare tunnel, which sets this header. */
export const clientIp = (req: FastifyRequest) => {
  const h = req.headers['cf-connecting-ip'];
  return (typeof h === 'string' && h) || req.ip;
};

/** Public API, reached through the Cloudflare Tunnel. */
export function buildApi(cfg: Config, state: EngineState, deps: ApiDeps): FastifyInstance {
  const { engine } = deps;
  const now = deps.now ?? Date.now;
  const fetchTorrent = deps.fetchTorrent ?? ((url: string) => fetchTorrentUrl(url, { maxBytes: cfg.MAX_TORRENT_FILE_KB * 1024 }));
  const app = Fastify({ logger: logger(cfg), bodyLimit: 64 * 1024 });

  app.register(cookie, { secret: cfg.SESSION_SECRET });
  app.register(cors, { origin: cfg.FRONTEND_ORIGIN, credentials: true, methods: ['GET', 'POST', 'DELETE'], maxAge: 600 });
  app.register(multipart, {
    limits: { files: 1, fileSize: cfg.MAX_TORRENT_FILE_KB * 1024, fields: 0, parts: 1, headerPairs: 50 },
  });
  errorHandler(app);

  // Browsers always send Origin on these methods; anything from another site is refused.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (origin && origin !== cfg.FRONTEND_ORIGIN) throw forbidden('requests from other sites are not allowed', 'bad_origin');
  });

  app.get('/api/health', async (_req, reply) => {
    if (!state.ready) return reply.code(503).send({ app: cfg.APP_NAME, status: 'starting' });
    return { app: cfg.APP_NAME, status: 'ok' };
  });

  // ---- session --------------------------------------------------------------

  app.get('/api/session', async (req) => ({
    app: cfg.APP_NAME,
    session: readSession(req) ? { active: true } : null,
    limits: limits(cfg),
  }));

  app.post('/api/session', async (req, reply) => {
    if (readSession(req)) return { session: { active: true } };
    startSession(reply, cfg);
    return reply.code(201).send({ session: { active: true } });
  });

  app.delete('/api/session', async (_req, reply) => {
    endSession(reply, cfg);
    return reply.code(204).send();
  });

  // ---- torrents -------------------------------------------------------------

  app.get('/api/torrents', async (req) => ({ torrents: engine.list(requireOwner(req)) }));

  app.post('/api/torrents', async (req, reply) => {
    const owner = requireOwner(req);
    let input: NewTorrent;
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw badRequest('attach a .torrent file', 'no_file');
      let buf: Buffer;
      try {
        buf = await file.toBuffer();
      } catch (err) {
        if ((err as FastifyError).statusCode === 413) {
          throw new ApiError(413, 'file_too_large', `.torrent files can be at most ${cfg.MAX_TORRENT_FILE_KB} KB`);
        }
        throw err;
      }
      const info = parseTorrentFile(buf, cfg.MAX_TORRENT_FILE_KB * 1024);
      input = { infoHash: info.infoHash, name: info.name, source: { file: buf, filename: 'upload.torrent' } };
    } else {
      const { source } = parse(addBody, req.body);
      if (/^magnet:/i.test(source)) {
        const m = parseMagnet(source);
        input = { infoHash: m.infoHash, name: m.name, source: { magnet: m.magnet } };
      } else if (/^https?:\/\//i.test(source)) {
        const buf = await fetchTorrent(source);
        const info = parseTorrentFile(buf, cfg.MAX_TORRENT_FILE_KB * 1024);
        input = { infoHash: info.infoHash, name: info.name, source: { file: buf, filename: 'download.torrent' } };
      } else {
        throw badRequest("that's not a magnet link or .torrent url", 'invalid_input');
      }
    }
    const torrent = await engine.add(owner, clientIp(req), input);
    return reply.code(201).send({ torrent });
  });

  app.delete('/api/torrents', async (req) => ({ removed: await engine.removeAll(requireOwner(req)) }));

  app.get('/api/torrents/:hash', async (req) => {
    const { hash } = parse(hashParam, req.params);
    return { torrent: engine.get(requireOwner(req), hash) };
  });

  app.get('/api/torrents/:hash/files', async (req) => {
    const { hash } = parse(hashParam, req.params);
    return { files: await engine.fileList(requireOwner(req), hash) };
  });

  app.post('/api/torrents/:hash/select', async (req) => {
    const owner = requireOwner(req);
    const { hash } = parse(hashParam, req.params);
    return { torrent: await engine.select(owner, hash, parse(selectBody, req.body)) };
  });

  const actions = {
    pause: engine.pause.bind(engine),
    resume: engine.resume.bind(engine),
    recheck: engine.recheck.bind(engine),
    'stop-seeding': engine.stopSeeding.bind(engine),
  } as const;
  for (const [name, fn] of Object.entries(actions)) {
    app.post(`/api/torrents/:hash/${name}`, async (req) => {
      const owner = requireOwner(req);
      const { hash } = parse(hashParam, req.params);
      return { torrent: await fn(owner, hash) };
    });
  }

  app.delete('/api/torrents/:hash', async (req, reply) => {
    const owner = requireOwner(req);
    const { hash } = parse(hashParam, req.params);
    await engine.remove(owner, hash);
    return reply.code(204).send();
  });

  app.get('/api/torrents/:hash/links', async (req) => {
    const owner = requireOwner(req);
    const { hash } = parse(hashParam, req.params);
    return makeLinks(cfg, engine, owner, hash, now());
  });

  // ---- live updates (server-sent events) ------------------------------------

  app.get('/api/events', async (req, reply) => {
    const owner = requireOwner(req);
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    reply.hijack();
    let last = '';
    const send = () => {
      const data = JSON.stringify(engine.list(owner));
      if (data === last) return;
      last = data;
      reply.raw.write(`event: torrents\ndata: ${data}\n\n`);
    };
    reply.raw.write('retry: 3000\n\n');
    send();
    const onUpdate = () => {
      try {
        send();
      } catch (err) {
        req.log.warn({ err }, 'live update failed');
      }
    };
    engine.on('update', onUpdate);
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => {
      engine.off('update', onUpdate);
      clearInterval(ping);
    });
  });

  return app;
}

/** File downloads, reached through Caddy on the DNS-only download domain. */
export function buildDl(cfg: Config, engine: Engine, now: () => number = Date.now): FastifyInstance {
  // signed tokens are longer than Fastify's default 100-character parameter limit
  const app = Fastify({ logger: logger(cfg), maxParamLength: 2048 });
  errorHandler(app);
  app.get('/dl/health', async () => ({ status: 'ok' }));
  registerDownloadRoutes(app, cfg, engine, now);
  return app;
}
