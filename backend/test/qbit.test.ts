import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { applyAndVerify, desiredPreferences, verifyPreferences } from '../src/protocol.js';
import { QbitClient, QbitError } from '../src/qbit.js';
import { testEnv } from './env.js';
import { startFakeQbit, type FakeQbit } from './fake-qbit.js';

let fake: FakeQbit;
beforeEach(async () => {
  fake = await startFakeQbit();
});
afterEach(async () => {
  await fake.close();
});

const client = (password = 'correct horse battery') => new QbitClient({ baseUrl: fake.url + '/', username: 'sayl', password });

describe('QbitClient', () => {
  it('logs in with the per-port cookie and calls the api', async () => {
    const q = client();
    expect(await q.version()).toBe('v5.2.4');
    expect(await q.webApiVersion()).toBe('2.15.1');
    expect(fake.logins).toBe(1);
  });

  it('logs in only once for concurrent requests', async () => {
    const q = client();
    await Promise.all([q.version(), q.preferences(), q.transferInfo()]);
    expect(fake.logins).toBe(1);
  });

  it('logs in again when the session expires', async () => {
    const q = client();
    await q.version();
    fake.expireSessions();
    expect(await q.version()).toBe('v5.2.4');
    expect(fake.logins).toBe(2);
  });

  it('reports a wrong password clearly', async () => {
    await expect(client('wrong password!').version()).rejects.toThrow(QbitError);
    await expect(client('wrong password!').version()).rejects.toThrow(/QBIT_PASSWORD/);
  });

  it('works with the pre-5.2 login replies too', async () => {
    const old = await startFakeQbit('sayl', 'correct horse battery', true);
    try {
      expect(await new QbitClient({ baseUrl: old.url, username: 'sayl', password: 'correct horse battery' }).version()).toBe('v5.2.4');
      await expect(new QbitClient({ baseUrl: old.url, username: 'sayl', password: 'nope nope nope' }).version()).rejects.toThrow(/QBIT_PASSWORD/);
    } finally {
      await old.close();
    }
  });

  it('fails cleanly when qbittorrent is unreachable', async () => {
    const q = new QbitClient({ baseUrl: 'http://127.0.0.1:1', username: 'a', password: 'b', timeoutMs: 2000 });
    await expect(q.version()).rejects.toThrow();
  });
});

describe('protocol settings', () => {
  const cfg = loadConfig(testEnv({ TORRENT_PORT: '51413', ENCRYPTION_MODE: 'require', UPLOAD_LIMIT_KIBPS: '5120' }));

  it('maps .env to qbittorrent preferences', () => {
    const p = desiredPreferences(cfg);
    expect(p).toMatchObject({
      dht: true,
      pex: true,
      lsd: true,
      bittorrent_protocol: 0,
      encryption: 1,
      listen_port: 51413,
      upnp: false,
      current_interface_address: '',
      up_limit: 5120 * 1024,
      dl_limit: 0,
      max_active_torrents: 20,
      torrent_content_layout: 'Subfolder',
      ssrf_mitigation: true,
      block_peers_on_privileged_ports: true,
    });
  });

  it('applies the settings and finds no mismatches', async () => {
    const report = await applyAndVerify(client(), cfg);
    expect(report.mismatches).toEqual([]);
    expect(report.version).toBe('v5.2.4');
    expect(fake.prefs).toMatchObject({ dht: true, pex: true, lsd: true, encryption: 1, listen_port: 51413 });
  });

  it('treats a trailing slash on paths as equal', async () => {
    await applyAndVerify(client(), cfg);
    fake.prefs.save_path = '/downloads';
    expect((await verifyPreferences(client(), cfg)).mismatches).toEqual([]);
  });

  it('reports settings qbittorrent did not accept', async () => {
    fake.ignoreKeys.add('dht');
    const report = await applyAndVerify(client(), cfg);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatch(/^dht: wanted true/);
  });
});
