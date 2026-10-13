import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseRetentionTiers, readBrandName } from '../src/config.js';
import { testEnv } from './env.js';

describe('config', () => {
  it('applies the agreed defaults', () => {
    const c = loadConfig(testEnv());
    expect(c.APP_NAME).toBe('Sayl');
    expect(c.MAX_ACTIVE_PER_USER).toBe(3);
    expect(c.MAX_STORAGE_PER_USER_GB).toBe(20);
    expect(c.MAX_TORRENT_SIZE_GB).toBe(20);
    expect(c.GLOBAL_STORAGE_CAP_GB).toBe(120);
    expect(c.GLOBAL_MAX_ACTIVE_TORRENTS).toBe(20);
    expect(c.STALL_TIMEOUT_HOURS).toBe(6);
    expect(c.SEED_MAX_MINUTES).toBe(60);
    expect(c.UPLOAD_LIMIT_KIBPS).toBe(5120);
    expect(c.ENCRYPTION_MODE).toBe('prefer');
    expect(c.RETENTION_TIERS.map((t) => t.hours)).toEqual([24, 12, 6, 3]);
  });

  it('lets APP_NAME override brand.json', () => {
    expect(loadConfig(testEnv({ APP_NAME: 'Flood' })).APP_NAME).toBe('Flood');
  });

  it('treats empty values as unset', () => {
    expect(loadConfig(testEnv({ APP_NAME: '', TORRENT_PORT: '' })).TORRENT_PORT).toBe(6881);
  });

  it('rejects short secrets and passwords', () => {
    expect(() => loadConfig(testEnv({ SESSION_SECRET: 'short' }))).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig(testEnv({ QBIT_PASSWORD: 'short' }))).toThrow(/QBIT_PASSWORD/);
  });

  it('rejects missing qbittorrent credentials', () => {
    const env = testEnv();
    delete env.QBIT_USERNAME;
    expect(() => loadConfig(env)).toThrow(/QBIT_USERNAME/);
  });

  it('rejects bad ports and enums', () => {
    expect(() => loadConfig(testEnv({ TORRENT_PORT: '80' }))).toThrow();
    expect(() => loadConfig(testEnv({ ENCRYPTION_MODE: 'maybe' }))).toThrow();
    expect(() => loadConfig(testEnv({ API_PORT: '9000', DL_PORT: '9000' }))).toThrow(/must differ/);
  });

  it('requires retention tiers to cover the max torrent size', () => {
    expect(() => loadConfig(testEnv({ RETENTION_TIERS: '3:24,5:12' }))).toThrow(/cover/);
  });
});

describe('parseRetentionTiers', () => {
  it('parses gb:hours pairs', () => {
    expect(parseRetentionTiers('3:24, 5:12,10:6,20:3')).toEqual([
      { maxBytes: 3e9, hours: 24 },
      { maxBytes: 5e9, hours: 12 },
      { maxBytes: 10e9, hours: 6 },
      { maxBytes: 20e9, hours: 3 },
    ]);
  });

  it('rejects malformed, non-positive and unsorted tiers', () => {
    expect(() => parseRetentionTiers('3-24')).toThrow(/gb:hours/);
    expect(() => parseRetentionTiers('0:24')).toThrow(/positive/);
    expect(() => parseRetentionTiers('5:12,3:24')).toThrow(/ascending/);
  });
});

describe('readBrandName', () => {
  it('reads the repo brand.json', () => {
    expect(readBrandName()).toBe('Sayl');
  });

  it('falls back to Sayl when the file is missing or invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    writeFileSync(join(dir, 'bad.json'), '{not json');
    expect(readBrandName(pathToFileURL(join(dir, 'missing.json')))).toBe('Sayl');
    expect(readBrandName(pathToFileURL(join(dir, 'bad.json')))).toBe('Sayl');
  });
});
