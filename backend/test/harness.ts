import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApi, buildDl } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { Db } from '../src/db.js';
import { Engine, ownerTag } from '../src/engine.js';
import { QbitClient } from '../src/qbit.js';
import { COOKIE_NAME, ownerIdFor } from '../src/session.js';
import { InputError } from '../src/torrent-input.js';
import { testEnv } from './env.js';
import { startFakeQbit, type FakeQbit } from './fake-qbit.js';

export const ORIGIN = 'https://sayl.test';

/** A browser-like client with its own session cookie. */
export class Client {
  constructor(
    readonly app: FastifyInstance,
    readonly cookie: string,
    /** sent as CF-Connecting-IP, like the tunnel does */
    readonly ip = '203.0.113.' + Math.floor(Math.random() * 250 + 1),
  ) {}

  private get h() {
    return { cookie: this.cookie, 'cf-connecting-ip': this.ip };
  }

  get owner(): string {
    const signed = this.cookie.slice(this.cookie.indexOf('=') + 1);
    return ownerIdFor(signed.slice(0, signed.lastIndexOf('.')));
  }

  get tag(): string {
    return ownerTag(this.owner);
  }

  get(url: string) {
    return this.app.inject({ method: 'GET', url, headers: this.h });
  }

  post(url: string, payload?: unknown) {
    return this.app.inject({
      method: 'POST',
      url,
      headers: { ...this.h, origin: ORIGIN, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
  }

  del(url: string) {
    return this.app.inject({ method: 'DELETE', url, headers: { ...this.h, origin: ORIGIN } });
  }

  upload(file: Buffer, filename = 'x.torrent') {
    const boundary = '----saylboundary' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="torrent"; filename="${filename}"\r\nContent-Type: application/x-bittorrent\r\n\r\n`),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return this.app.inject({
      method: 'POST',
      url: '/api/torrents',
      headers: { ...this.h, origin: ORIGIN, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
  }

  async addMagnet(hash: string, name = 'test') {
    return this.post('/api/torrents', { source: `magnet:?xt=urn:btih:${hash}&dn=${name}` });
  }
}

export interface Harness {
  fake: FakeQbit;
  cfg: Config;
  db: Db;
  engine: Engine;
  api: FastifyInstance;
  dl: FastifyInstance;
  dir: string;
  clock: { now: number };
  /** urls the stubbed .torrent fetcher can serve */
  remote: Map<string, Buffer>;
  /** free disk space the engine sees */
  disk: { free: number | null };
  /** the stubbed Turnstile check accepts the token "good-token" while pass is true */
  captcha: { pass: boolean; calls: { token: string; ip: string }[] };
  user(ip?: string): Promise<Client>;
  tick(): Promise<void>;
  close(): Promise<void>;
}

export async function harness(overrides: Record<string, string> = {}): Promise<Harness> {
  const fake = await startFakeQbit();
  const dir = mkdtempSync(join(tmpdir(), 'sayl-dl-'));
  const cfg = loadConfig(
    testEnv({ QBIT_URL: fake.url, DOWNLOADS_DIR: dir, FRONTEND_ORIGIN: ORIGIN, DL_PUBLIC_URL: 'https://dl.test', ...overrides }),
  );
  const clock = { now: 1_800_000_000_000 };
  const q = new QbitClient({ baseUrl: cfg.QBIT_URL, username: cfg.QBIT_USERNAME, password: cfg.QBIT_PASSWORD });
  const db = new Db(':memory:');
  const disk = { free: 1e15 as number | null };
  const engine = new Engine(q, db, cfg, () => clock.now, undefined, async () => disk.free);
  const captcha = { pass: true, calls: [] as { token: string; ip: string }[] };
  const remote = new Map<string, Buffer>();
  const api = buildApi(cfg, { ready: true, error: null }, {
    engine,
    db,
    verifyCaptcha: async (token, ip) => {
      captcha.calls.push({ token, ip });
      return captcha.pass && token === 'good-token';
    },
    now: () => clock.now,
    fetchTorrent: async (url) => {
      const b = remote.get(url);
      if (!b) throw new InputError("couldn't download that .torrent url");
      return b;
    },
  });
  const dl = buildDl(cfg, engine, () => clock.now);
  return {
    fake,
    cfg,
    db,
    engine,
    api,
    dl,
    dir,
    clock,
    remote,
    disk,
    captcha,
    async user(ip?: string) {
      const r = await api.inject({ method: 'POST', url: '/api/session', headers: { origin: ORIGIN, ...(ip ? { 'cf-connecting-ip': ip } : {}) } });
      const c = r.cookies.find((x) => x.name === COOKIE_NAME);
      if (!c) throw new Error(`no session cookie: ${r.statusCode} ${r.body}`);
      return new Client(api, `${c.name}=${c.value}`, ip);
    },
    tick: () => engine.tick(),
    async close() {
      await Promise.all([api.close(), dl.close(), fake.close()]);
      db.close();
    },
  };
}

export const json = <T = Record<string, unknown>>(r: LightMyRequestResponse) => r.json() as T;
export const hashOf = (n: number) => n.toString(16).padStart(2, '0').repeat(20);
