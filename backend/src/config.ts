import { readFileSync } from 'node:fs';
import { z } from 'zod';

const GB = 1e9;

/**
 * The product name lives in /brand.json at the repo root. APP_NAME in .env
 * overrides it, so renaming the app never needs a code change.
 */
export function readBrandName(file: URL = new URL('../../brand.json', import.meta.url)): string {
  try {
    const brand = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown };
    if (typeof brand.name === 'string' && brand.name.trim()) return brand.name.trim();
  } catch {
    // fall through to the built-in default
  }
  return 'Sayl';
}

export interface RetentionTier {
  /** Largest selected size (bytes) this tier covers. */
  maxBytes: number;
  /** Hours the files are kept after the torrent finishes. */
  hours: number;
}

/** Parses "3:24,5:12,10:6,20:3" (gb:hours) into ascending tiers. */
export function parseRetentionTiers(raw: string): RetentionTier[] {
  const tiers = raw.split(',').map((part) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (!m) throw new Error(`bad retention tier "${part}", expected gb:hours`);
    const gb = Number(m[1]);
    const hours = Number(m[2]);
    if (gb <= 0 || hours <= 0) throw new Error(`retention tier "${part}" must be positive`);
    return { maxBytes: gb * GB, hours };
  });
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i]!.maxBytes <= tiers[i - 1]!.maxBytes) throw new Error('retention tiers must be in ascending size order');
  }
  return tiers;
}

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().min(1);
const secret = (name: string) =>
  z.string().min(32, `${name} must be at least 32 characters (try: openssl rand -hex 32)`);

const schema = z.object({
  APP_NAME: z.string().trim().min(1).optional(),
  HOST: z.string().default('0.0.0.0'),
  API_PORT: port.default(8080),
  DL_PORT: port.default(8081),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  FRONTEND_ORIGIN: z.url().default('http://localhost:5173'),
  DL_DOMAIN: z.string().default('localhost'),

  QBIT_URL: z.url().default('http://qbittorrent:8080'),
  QBIT_USERNAME: z.string().min(1),
  QBIT_PASSWORD: z.string().min(12, 'QBIT_PASSWORD must be at least 12 characters'),
  TORRENT_PORT: z.coerce.number().int().min(1024).max(65535).default(6881),
  ENCRYPTION_MODE: z.enum(['prefer', 'require', 'disable']).default('prefer'),
  UPLOAD_LIMIT_KIBPS: z.coerce.number().int().min(0).default(5120),
  DOWNLOAD_LIMIT_KIBPS: z.coerce.number().int().min(0).default(0),
  GLOBAL_MAX_ACTIVE_TORRENTS: positiveInt.default(20),

  SESSION_SECRET: secret('SESSION_SECRET'),
  DOWNLOAD_URL_SECRET: secret('DOWNLOAD_URL_SECRET'),
  ACCESS_CODE: z.string().default(''),
  TURNSTILE_SECRET_KEY: z.string().default(''),

  MAX_ACTIVE_PER_USER: positiveInt.default(3),
  MAX_STORAGE_PER_USER_GB: z.coerce.number().positive().default(20),
  MAX_TORRENT_SIZE_GB: z.coerce.number().positive().default(20),
  GLOBAL_STORAGE_CAP_GB: z.coerce.number().positive().default(120),
  RETENTION_TIERS: z.string().default('3:24,5:12,10:6,20:3'),
  STALL_TIMEOUT_HOURS: z.coerce.number().positive().default(6),
  SEED_MAX_MINUTES: positiveInt.default(60),
  DEFAULT_RATIO_LIMIT: z.coerce.number().positive().default(1),
  MAX_TORRENT_FILE_KB: positiveInt.default(4096),
});

export type Env = z.infer<typeof schema>;

export interface Config extends Omit<Env, 'APP_NAME' | 'RETENTION_TIERS'> {
  APP_NAME: string;
  RETENTION_TIERS: RetentionTier[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings from .env as "not set" so defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) throw new Error('invalid configuration:\n' + z.prettifyError(parsed.error));
  const c = parsed.data;
  if (c.API_PORT === c.DL_PORT) throw new Error('invalid configuration: API_PORT and DL_PORT must differ');
  const tiers = parseRetentionTiers(c.RETENTION_TIERS);
  const largest = tiers[tiers.length - 1]!;
  if (largest.maxBytes < c.MAX_TORRENT_SIZE_GB * GB) {
    throw new Error('invalid configuration: RETENTION_TIERS must cover MAX_TORRENT_SIZE_GB');
  }
  return { ...c, APP_NAME: c.APP_NAME ?? readBrandName(), RETENTION_TIERS: tiers };
}
