/**
 * Admin commands, run on the VPS:
 *   docker compose exec backend sayl-admin <command>
 * There is no public admin endpoint.
 */
import { loadConfig } from './config.js';
import { verifyPreferences } from './protocol.js';
import { QbitClient } from './qbit.js';

const USAGE = `usage: sayl-admin <command>

commands:
  status    show the qBittorrent version, protocol settings and connection state`;

async function status(): Promise<number> {
  const cfg = loadConfig();
  const q = new QbitClient({ baseUrl: cfg.QBIT_URL, username: cfg.QBIT_USERNAME, password: cfg.QBIT_PASSWORD });
  const [report, prefs, transfer] = await Promise.all([verifyPreferences(q, cfg), q.preferences(), q.transferInfo()]);
  const encryption = ['prefer', 'require', 'disable'][prefs.encryption ?? -1] ?? String(prefs.encryption);
  const protocol = ['tcp + utp', 'tcp only', 'utp only'][prefs.bittorrent_protocol ?? -1] ?? String(prefs.bittorrent_protocol);
  const lines = [
    `${cfg.APP_NAME} · qbittorrent ${report.version} (web api ${report.webApiVersion})`,
    `dht            ${prefs.dht ? 'on' : 'off'}`,
    `pex            ${prefs.pex ? 'on' : 'off'}`,
    `lsd            ${prefs.lsd ? 'on' : 'off'}`,
    `transport      ${protocol}`,
    `encryption     ${encryption}`,
    `listen port    ${prefs.listen_port} (upnp ${prefs.upnp ? 'on' : 'off'})`,
    `addresses      ${prefs.current_interface_address ? prefs.current_interface_address : 'all ipv4 + ipv6'}`,
    `upload cap     ${prefs.up_limit ? `${Math.round(Number(prefs.up_limit) / 1024)} KiB/s` : 'unlimited'}`,
    `download cap   ${prefs.dl_limit ? `${Math.round(Number(prefs.dl_limit) / 1024)} KiB/s` : 'unlimited'}`,
    `max active     ${prefs.max_active_torrents}`,
    `connection     ${transfer.connection_status} · ${transfer.dht_nodes} dht nodes`,
    report.mismatches.length ? `\nsettings that differ from .env:\n  ${report.mismatches.join('\n  ')}` : 'settings match .env',
  ];
  console.log(lines.join('\n'));
  return report.mismatches.length ? 2 : 0;
}

const command = process.argv[2];
try {
  if (command === 'status') process.exitCode = await status();
  else {
    console.error(USAGE);
    process.exitCode = command ? 1 : 0;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
