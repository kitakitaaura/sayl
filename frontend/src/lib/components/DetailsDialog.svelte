<script lang="ts">
  /** Browser engine: one torrent's peers, trackers, DHT and the rest, live; and "report a problem". */
  import Bug from '@lucide/svelte/icons/bug';
  import { onMount } from 'svelte';
  import type { TorrentDetails } from '$lib/browser/engine';
  import { reportUrl } from '$lib/browser/report';
  import { fmtBytes, fmtSpeed } from '$lib/format';
  import { app } from '$lib/state/app.svelte';
  import Dialog from './Dialog.svelte';

  let { hash, onclose }: { hash: string; onclose: () => void } = $props();

  const torrent = $derived(app.find(hash));
  let d = $state<TorrentDetails | null>(null);

  onMount(() => {
    const read = () => (d = app.details(hash));
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  });

  const sources = $derived(d ? Object.entries(d.peers.bySource).map(([k, n]) => `${n} from ${k}`).join(', ') || 'none yet' : '');
  const failures = $derived(d ? Object.entries(d.failures).map(([k, n]) => `${k} ×${n}`).join(', ') : '');
</script>

<Dialog title="details" subtitle={torrent?.name ?? ''} {onclose}>
  <div class="body">
    {#if !d}
      <p class="muted">this torrent is no longer in your list.</p>
    {:else}
      <table class="tabular">
        <tbody>
          <tr><th>status</th><td>{d.state}{d.running ? ' · running' : ''}{d.seed ? ' · sharing' : ''}{d.sequential ? ' · sequential' : ''}{d.created ? ' · made here' : ''}</td></tr>
          <tr><th>size</th><td>{d.selectedSize === null ? 'unknown' : fmtBytes(d.selectedSize)} chosen{d.size !== null ? ` of ${fmtBytes(d.size)}` : ''}{d.files !== null ? ` · ${d.files} file${d.files === 1 ? '' : 's'}` : ''}</td></tr>
          {#if d.pieces}<tr><th>pieces</th><td>{d.pieces.have} of {d.pieces.total} · {fmtBytes(d.pieces.size)} each</td></tr>{/if}
          <tr><th>speed</th><td>↓ {fmtSpeed(d.speed.down)} · ↑ {fmtSpeed(d.speed.up)}</td></tr>
          <tr><th>uploaded</th><td>{fmtBytes(d.uploaded)} · ratio {d.ratio.toFixed(2)}</td></tr>
          <tr><th>peers</th><td>{d.peers.connected} connected ({d.peers.seeds} seeds){d.running ? ` · ${d.peers.found} found, ${d.peers.tried} tried this run` : ''}</td></tr>
          {#if d.running}<tr><th>found via</th><td>{sources}</td></tr>{/if}
          <tr><th>dht</th><td>{d.dht}</td></tr>
          <tr><th>webrtc</th><td>{d.webrtc ? `on · ${d.peers.webrtc} browser${d.peers.webrtc === 1 ? '' : 's'} this run` : 'off (settings)'}</td></tr>
          {#if failures}<tr><th>failed to connect</th><td>{failures}</td></tr>{/if}
          {#if d.error}<tr><th>error</th><td class="err">{d.error}</td></tr>{/if}
        </tbody>
      </table>
      <h3>trackers ({d.trackers.length})</h3>
      <ul class="trackers">
        {#each d.trackers as tr (tr.url)}
          <li><span class="url" title={tr.url}>{tr.url}</span><span class="st" class:bad={tr.status.startsWith('failed')}>{tr.status}</span></li>
        {/each}
      </ul>
    {/if}
  </div>
  {#snippet footer()}
    <a class="btn" href={reportUrl(d)} target="_blank" rel="noopener"><Bug size={16} aria-hidden="true" />report a problem</a>
    <button type="button" class="btn" onclick={onclose}>done</button>
  {/snippet}
</Dialog>

<style>
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 16px 14px;
    font-size: 12.5px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th {
    width: 1%;
    padding: 5px 12px 5px 0;
    text-align: left;
    vertical-align: top;
    white-space: nowrap;
    font-weight: 500;
    color: var(--muted);
  }
  td {
    padding: 5px 0;
    color: var(--fg-2);
    overflow-wrap: anywhere;
  }
  .err {
    color: var(--err);
  }
  h3 {
    margin: 14px 0 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--muted);
  }
  .trackers {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .trackers li {
    display: flex;
    gap: 10px;
    justify-content: space-between;
    padding: 4px 0;
    border-top: 1px solid var(--border);
  }
  .url {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--fg-2);
  }
  .st {
    flex: none;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted);
  }
  .st.bad {
    color: var(--warn);
  }
  .muted {
    margin: 0;
    color: var(--muted);
  }
</style>
