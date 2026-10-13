import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';

/** Whether the backend has reached qBittorrent and verified its settings. */
export interface EngineState {
  ready: boolean;
  error: string | null;
}

function logger(cfg: Config) {
  return { level: cfg.LOG_LEVEL };
}

/** Public API, reached through the Cloudflare Tunnel. */
export function buildApi(cfg: Config, engine: EngineState): FastifyInstance {
  const app = Fastify({ logger: logger(cfg) });

  app.get('/api/health', async (_req, reply) => {
    if (!engine.ready) return reply.code(503).send({ app: cfg.APP_NAME, status: 'starting' });
    return { app: cfg.APP_NAME, status: 'ok' };
  });

  return app;
}

/** File downloads, reached through Caddy on the DNS-only download domain. */
export function buildDl(cfg: Config): FastifyInstance {
  const app = Fastify({ logger: logger(cfg) });

  app.get('/dl/health', async () => ({ status: 'ok' }));

  return app;
}
