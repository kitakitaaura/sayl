/**
 * "Report a problem": a GitHub issue filled in with what helps fix it — the build, the browser, the
 * relay's version, the settings and a torrent's technical state — and nothing that says what someone
 * downloads: no torrent names, info hashes, file names or tracker addresses (private trackers put
 * passkeys in them). People can see and edit it all before they post it.
 */
import { BUILD, RELAY_VERSION, REPO_URL } from '$lib/config';
import { relayConfig } from '$lib/browser/relay.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { TorrentDetails } from './engine';

const mb = (b: number | null) => (b === null ? 'unknown' : `${(b / 1e6).toFixed(1)} MB`);
const speed = (b: number) => `${(b / 1e6).toFixed(2)} MB/s`;

/** A short, generic reason: a tracker's own words or an error can name things, so only their first words. */
const generic = (s: string) => s.replace(/https?:\/\/\S+/g, '<address>').slice(0, 80);

export function reportText(t: TorrentDetails | null): string {
  const p = settings.prefs;
  const lines = [
    '**What happened?**',
    '',
    '<!-- what you did, what you expected, what you saw -->',
    '',
    '',
    '**Details** (filled in by Sayl: no torrent names, hashes or tracker addresses)',
    '',
    `- site build: ${BUILD}`,
    `- browser: ${navigator.userAgent}`,
    `- relay: ${relayConfig.version === null ? 'version unknown (unreachable?)' : `version ${relayConfig.version} (latest ${RELAY_VERSION})`}`,
    `- settings: webrtc ${p.webrtc ? 'on' : 'off'}, download limit ${p.downLimit || 'none'}, upload limit ${p.upLimit || 'none'}, screen on ${p.keepAwake ? 'yes' : 'no'}, list sync ${p.syncList ? 'on' : 'off'}`,
  ];
  if (t) {
    const trackers = t.trackers.map((x) => x.status);
    const ok = trackers.filter((s) => /^\d+ peers$/.test(s)).length;
    const failed = trackers.filter((s) => s.startsWith('failed')).map(generic);
    lines.push(
      `- torrent: ${t.state}${t.running ? ', running' : ''}, ${mb(t.selectedSize)} chosen of ${mb(t.size)}, ${t.files ?? '?'} files` +
        (t.pieces ? `, ${t.pieces.have}/${t.pieces.total} pieces of ${t.pieces.size / 1024} KiB` : ', no metadata yet'),
      `- speed: down ${speed(t.speed.down)}, up ${speed(t.speed.up)}; uploaded ${mb(t.uploaded)}${t.seed ? ', seeding on' : ''}${t.sequential ? ', sequential' : ''}${t.created ? ', made here' : ''}`,
      `- peers: ${t.peers.connected} connected (${t.peers.seeds} seeds); this run: ${t.peers.found} found, ${t.peers.tried} tried, ${t.peers.handshaken} handshakes, ${t.peers.webrtc} over webrtc; from ${JSON.stringify(t.peers.bySource)}`,
      `- trackers: ${trackers.length}, ${ok} answered${failed.length ? `; failures: ${[...new Set(failed)].slice(0, 5).join(' | ')}` : ''}`,
      `- dht: ${generic(t.dht)}`,
      `- connection failures: ${JSON.stringify(t.failures)}`,
    );
    if (t.error) lines.push(`- error: ${generic(t.error)}`);
  }
  return lines.join('\n');
}

/** The new-issue page on GitHub, filled in. */
export function reportUrl(t: TorrentDetails | null): string {
  const u = new URL(`${REPO_URL}/issues/new`);
  u.searchParams.set('title', t ? `Problem with a torrent (${t.state})` : 'Problem: ');
  u.searchParams.set('body', reportText(t));
  return u.toString();
}
