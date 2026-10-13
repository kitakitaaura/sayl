import type { Config } from './config.js';
import type { QbitClient, QbitPreferences } from './qbit.js';

const ENCRYPTION = { prefer: 0, require: 1, disable: 2 } as const;
const KIB = 1024;

/**
 * qBittorrent settings Sayl owns. The backend applies them on every start and
 * reads them back, so the engine can't drift from what .env says.
 */
export function desiredPreferences(c: Config): QbitPreferences {
  return {
    // peer discovery
    dht: true,
    pex: true,
    lsd: true,
    // 0 = TCP and uTP
    bittorrent_protocol: 0,
    // 0 = prefer encryption, 1 = require it, 2 = disable it
    encryption: ENCRYPTION[c.ENCRYPTION_MODE],
    // listening: fixed port, no UPnP on a VPS, all IPv4 and IPv6 addresses
    listen_port: c.TORRENT_PORT,
    random_port: false,
    upnp: false,
    current_network_interface: '',
    current_interface_address: '',
    anonymous_mode: false,
    // global caps
    queueing_enabled: true,
    max_active_torrents: c.GLOBAL_MAX_ACTIVE_TORRENTS,
    max_active_downloads: c.GLOBAL_MAX_ACTIVE_TORRENTS,
    max_active_uploads: c.GLOBAL_MAX_ACTIVE_TORRENTS,
    // bytes per second, 0 = unlimited
    dl_limit: c.DOWNLOAD_LIMIT_KIBPS * KIB,
    up_limit: c.UPLOAD_LIMIT_KIBPS * KIB,
    // storage: every torrent in its own folder under /downloads
    save_path: '/downloads/',
    temp_path_enabled: false,
    auto_tmm_enabled: false,
    torrent_content_layout: 'Subfolder',
  };
}

/** Normalises paths so "/downloads" and "/downloads/" compare equal. */
function same(want: unknown, got: unknown): boolean {
  if (typeof want === 'string' && typeof got === 'string' && want.startsWith('/')) {
    return want.replace(/\/+$/, '') === got.replace(/\/+$/, '');
  }
  return want === got;
}

export interface ProtocolReport {
  version: string;
  webApiVersion: string;
  mismatches: string[];
  applied: QbitPreferences;
}

/** Reads qBittorrent's settings and lists every difference from what Sayl wants. */
export async function verifyPreferences(q: QbitClient, c: Config): Promise<ProtocolReport> {
  const want = desiredPreferences(c);
  const got = await q.preferences();
  const mismatches = Object.entries(want)
    .filter(([k, v]) => !same(v, got[k]))
    .map(([k, v]) => `${k}: wanted ${JSON.stringify(v)}, qbittorrent has ${JSON.stringify(got[k])}`);
  const [version, webApiVersion] = await Promise.all([q.version(), q.webApiVersion()]);
  return { version, webApiVersion, mismatches, applied: want };
}

export async function applyAndVerify(q: QbitClient, c: Config): Promise<ProtocolReport> {
  await q.setPreferences(desiredPreferences(c));
  return verifyPreferences(q, c);
}
