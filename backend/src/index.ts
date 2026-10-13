import { setTimeout as sleep } from 'node:timers/promises';
import { buildApi, buildDl, type EngineState } from './app.js';
import { loadConfig } from './config.js';
import { applyAndVerify } from './protocol.js';
import { QbitClient } from './qbit.js';

const cfg = loadConfig();
const engine: EngineState = { ready: false, error: null };
const qbit = new QbitClient({ baseUrl: cfg.QBIT_URL, username: cfg.QBIT_USERNAME, password: cfg.QBIT_PASSWORD });

const api = buildApi(cfg, engine);
const dl = buildDl(cfg);
const log = api.log;

/** Retries until qBittorrent is up, then applies and checks Sayl's settings. */
async function connectEngine(): Promise<void> {
  let delay = 1000;
  for (;;) {
    try {
      const report = await applyAndVerify(qbit, cfg);
      if (report.mismatches.length) {
        engine.error = 'qbittorrent did not accept some settings';
        log.error({ mismatches: report.mismatches }, engine.error);
      } else {
        engine.ready = true;
        engine.error = null;
        log.info({ version: report.version, webApi: report.webApiVersion }, 'qbittorrent ready, settings verified');
      }
      return;
    } catch (err) {
      engine.error = err instanceof Error ? err.message : String(err);
      log.warn({ err: engine.error, retryInMs: delay }, 'waiting for qbittorrent');
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
    void Promise.all([api.close(), dl.close()]).then(() => process.exit(0));
  });
}
