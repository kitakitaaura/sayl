/**
 * Admin commands, run on the VPS:
 *   docker compose exec backend sayl-admin <command>
 * There is no public admin endpoint.
 */
import { join } from 'node:path';
import { AdminError, banIp, blockTorrent, listTorrents, unbanIp, unblockTorrent } from './admin.js';
import { loadConfig, type Config } from './config.js';
import { Db } from './db.js';
import { verifyPreferences } from './protocol.js';
import { QbitClient } from './qbit.js';

const USAGE = `usage: sayl-admin <command>

commands:
  status                        qBittorrent version, protocol settings and connection state
  list [--ips]                  every torrent on the server, with owner count (and their IPs)
  block <hash|magnet> [reason]  delete a torrent for everyone and stop it being added again
  unblock <hash|magnet>         allow a blocked torrent again
  ban-ip <ip> [reason] [--purge]
                                block an address from the API; --purge also deletes its torrents
  unban-ip <ip>                 lift a ban
  blocklist                     show blocked torrents and banned addresses`;

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} gb` : `${(b / 1e6).toFixed(1)} mb`);
const when = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);

async function status(cfg: Config, q: QbitClient): Promise<number> {
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

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }
  const cfg = loadConfig();
  const q = new QbitClient({ baseUrl: cfg.QBIT_URL, username: cfg.QBIT_USERNAME, password: cfg.QBIT_PASSWORD });
  if (command === 'status') return status(cfg, q);

  const db = new Db(join(cfg.DATA_DIR, 'sayl.db'));
  try {
    const now = Date.now();
    switch (command) {
      case 'list': {
        const rows = await listTorrents(db, q);
        if (!rows.length) console.log('no torrents');
        for (const r of rows) {
          console.log(`${r.hash}  ${r.state.padEnd(11)} ${size(r.size).padStart(10)}  ${(r.progress * 100).toFixed(0).padStart(3)}%  ${r.owners.length} owner${r.owners.length === 1 ? '' : 's'}  ${r.name}`);
          console.log(`    uploaded ${size(r.uploaded)} · ratio ${r.ratio.toFixed(3)} · up ${size(r.upSpeed)}/s · ${r.peers} peers connected`);
          if (flags.has('--ips')) for (const o of r.owners) console.log(`    ${o.ip}  added ${when(o.addedAt)}${o.completedAt ? `  finished ${when(o.completedAt)}` : ''}`);
        }
        return 0;
      }
      case 'block': {
        if (!args[0]) throw new AdminError('usage: sayl-admin block <hash|magnet> [reason]');
        const r = await blockTorrent(db, q, args[0], args.slice(1).join(' '), now);
        console.log(`blocked ${r.hash}${r.deleted ? `, deleted it and its files (${r.owners} owner${r.owners === 1 ? '' : 's'})` : ' (it was not on the server)'}`);
        return 0;
      }
      case 'unblock': {
        if (!args[0]) throw new AdminError('usage: sayl-admin unblock <hash|magnet>');
        const r = unblockTorrent(db, args[0]);
        console.log(r.removed ? `unblocked ${r.hash}` : `${r.hash} wasn't blocked`);
        return 0;
      }
      case 'ban-ip': {
        if (!args[0]) throw new AdminError('usage: sayl-admin ban-ip <ip> [reason] [--purge]');
        const r = await banIp(db, q, args[0], args.slice(1).join(' '), now, flags.has('--purge'));
        console.log(`banned ${r.ip}${flags.has('--purge') ? `, removed ${r.purged} of its torrents` : ''}`);
        return 0;
      }
      case 'unban-ip': {
        if (!args[0]) throw new AdminError('usage: sayl-admin unban-ip <ip>');
        const r = unbanIp(db, args[0]);
        console.log(r.removed ? `unbanned ${r.ip}` : `${r.ip} wasn't banned`);
        return 0;
      }
      case 'blocklist': {
        const blocked = db.blocked();
        const bans = db.bans();
        console.log(`blocked torrents (${blocked.length})`);
        for (const b of blocked) console.log(`  ${b.hash}  ${when(b.createdAt)}  ${b.reason}`);
        console.log(`banned addresses (${bans.length})`);
        for (const b of bans) console.log(`  ${b.ip}  ${when(b.createdAt)}  ${b.reason}`);
        return 0;
      }
      default:
        console.error(USAGE);
        return 1;
    }
  } finally {
    db.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
