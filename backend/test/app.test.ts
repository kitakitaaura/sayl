import { describe, expect, it } from 'vitest';
import { buildApi, buildDl } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { testEnv } from './env.js';

const cfg = loadConfig(testEnv());

describe('api health', () => {
  it('returns 503 until qbittorrent is verified', async () => {
    const app = buildApi(cfg, { ready: false, error: 'waiting' });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ app: 'Sayl', status: 'starting' });
  });

  it('returns 200 once ready, without leaking engine details', async () => {
    const app = buildApi(cfg, { ready: true, error: null });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ app: 'Sayl', status: 'ok' });
  });

  it('does not serve download routes on the api port', async () => {
    const app = buildApi(cfg, { ready: true, error: null });
    expect((await app.inject({ method: 'GET', url: '/dl/health' })).statusCode).toBe(404);
  });
});

describe('download server', () => {
  it('answers its health check and nothing from the api', async () => {
    const app = buildDl(cfg);
    expect((await app.inject({ method: 'GET', url: '/dl/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(404);
  });
});
