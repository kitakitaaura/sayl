import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { buildApi, buildDl, type EngineState } from './app.js';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Engine } from './engine.js';
import { applyAndVerify } from './protocol.js';
import { QbitClient } from './qbit.js';

const cfg = loadConfig();
const state: EngineState = { ready: false, error: null };
const qbit = new QbitClient({ baseUrl: cfg.QBIT_URL, username: cfg.QBIT_USERNAME, password: cfg.QBIT_PASSWORD });
const db = new Db(join(cfg.DATA_DIR, 'sayl.db'));

// the engine logs through the API server's logger, created just below
let api: FastifyInstance | undefined;
const engine = new Engine(qbit, db, cfg, Date.now, (err) =>
  api?.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'engine poll failed'),
);
api = buildApi(cfg, state, { engine });
const dl = buildDl(cfg, engine);
const log = api.log;

/** Retries until qBittorrent is up, applies Sayl's settings, then starts polling. */
async function connectEngine(): Promise<void> {
  let delay = 1000;
  for (;;) {
    try {
      const report = await applyAndVerify(qbit, cfg);
      if (report.mismatches.length) {
        state.error = 'qbittorrent did not accept some settings';
        log.error({ mismatches: report.mismatches }, state.error);
      } else {
        state.ready = true;
        state.error = null;
        log.info({ version: report.version, webApi: report.webApiVersion }, 'qbittorrent ready, settings verified');
      }
      engine.start();
      return;
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      log.warn({ err: state.error, retryInMs: delay }, 'waiting for qbittorrent');
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }
}

await api.listen({ host: cfg.HOST, port: cfg.API_PORT });
await dl.listen({ host: cfg.HOST, port: cfg.DL_PORT });
log.info({ app: cfg.APP_NAME }, 'started');
void connectEngine();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');
    engine.stop();
    void Promise.all([api.close(), dl.close()]).then(() => {
      db.close();
      process.exit(0);
    });
  });
}
