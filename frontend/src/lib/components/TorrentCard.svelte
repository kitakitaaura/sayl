<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  import Clock from '@lucide/svelte/icons/clock';
  import Download from '@lucide/svelte/icons/download';
  import ListChecks from '@lucide/svelte/icons/list-checks';
  import Pause from '@lucide/svelte/icons/pause';
  import Play from '@lucide/svelte/icons/play';
  import MonitorPlay from '@lucide/svelte/icons/monitor-play';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import Share2 from '@lucide/svelte/icons/share-2';
  import Upload from '@lucide/svelte/icons/upload';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Users from '@lucide/svelte/icons/users';
  import type { TorrentView } from '$lib/api';
  import { BROWSER_ENGINE } from '$lib/config';
  import { fmtBytes, fmtDur, fmtSpeed, keepHours } from '$lib/format';
  import { app, errorMessage } from '$lib/state/app.svelte';
  import { settings } from '$lib/state/settings.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import { ui } from '$lib/state/ui.svelte';

  let { t }: { t: TorrentView } = $props();

  const LABEL: Record<TorrentView['state'], string> = {
    metadata: 'finding files',
    selecting: 'pick files',
    queued: 'queued',
    downloading: 'downloading',
    stalled: 'stalled',
    checking: 'checking',
    paused: 'paused',
    seeding: 'seeding',
    done: 'done',
    error: 'error',
  };

  const finished = $derived(t.progress >= 1 || t.completedAt !== null);
  const size = $derived(t.selectedSize ?? t.totalSize);
  const deletesAt = $derived.by(() => {
    if (t.completedAt === null || t.selectedSize === null) return null;
    const h = keepHours(t.selectedSize, app.limits);
    return h === null ? null : t.completedAt + h * 3600_000;
  });
  const sub = $derived.by(() => {
    const parts = [size === null ? 'size unknown' : fmtBytes(size)];
    if (finished && deletesAt !== null) parts.push(`deletes in ${fmtDur((deletesAt - app.now) / 1000)}`);
    else if (t.state !== 'metadata' && t.state !== 'selecting') parts.push(`${(t.progress * 100).toFixed(1)}%`);
    if (settings.prefs.showHashes) parts.push(t.hash);
    return parts.join(' · ');
  });
  // a tiny ratio would round to 0.00 and look like nothing was shared
  const ratio = (r: number) => (r > 0 && r < 0.01 ? '<0.01' : r.toFixed(2));
  const active = $derived(['queued', 'downloading', 'stalled'].includes(t.state));
  const canPause = $derived(active || t.state === 'seeding');

  async function download() {
    try {
      const links = await app.links(t.hash);
      if (links.files.length > 1) {
        ui.open({ kind: 'download', hash: t.hash });
        return;
      }
      const f = links.files[0];
      if (!f) {
        toasts.push('no finished files yet', 'info');
        return;
      }
      // the download domain answers with Content-Disposition: attachment, so the page stays put
      const a = document.createElement('a');
      a.href = f.url;
      a.rel = 'noopener';
      // the server's links say "attachment" themselves; the browser engine's need the file name here
      if (f.url.startsWith('blob:')) a.download = f.path.split('/').pop() ?? f.path;
      a.click();
      app.downloaded(t.hash);
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
    }
  }
</script>

<article class="card st-{t.state}" aria-label={t.name}>
  <div class="top">
    <div class="title">
      {#if BROWSER_ENGINE}
        <button type="button" class="name linkname" title="{t.name} · details" aria-label="details for {t.name}" onclick={() => ui.open({ kind: 'details', hash: t.hash })}>{t.name}</button>
      {:else}
        <div class="name" title={t.name}>{t.name}</div>
      {/if}
      <div class="sub tabular">{sub}</div>
    </div>
    <span class="pill">{LABEL[t.state]}</span>
  </div>

  <div class="bar" role="progressbar" aria-label="progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(t.progress * 100)}>
    <div class="fill" style="width: {t.progress * 100}%"></div>
  </div>

  <div class="foot">
    <div class="stats tabular">
      {#if t.state === 'downloading' || t.state === 'stalled' || t.state === 'queued'}
        <span title="download speed"><ArrowDown size={13} aria-hidden="true" /><span class="sr">download speed: </span>{fmtSpeed(t.dlSpeed)}</span>
        {#if !BROWSER_ENGINE || t.seed}<span title="upload speed"><ArrowUp size={13} aria-hidden="true" /><span class="sr">upload speed: </span>{fmtSpeed(t.upSpeed)}</span>{/if}
        <span title="time left"><Clock size={13} aria-hidden="true" /><span class="sr">time left: </span>{t.eta === null ? '—' : fmtDur(t.eta)}</span>
        <span title="peers · seeds"><Users size={13} aria-hidden="true" /><span class="sr">peers and seeds: </span>{t.peers} · {t.seeds}</span>
      {:else if t.state === 'seeding'}
        <span title="upload speed"><ArrowUp size={13} aria-hidden="true" /><span class="sr">upload speed: </span>{fmtSpeed(t.upSpeed)}</span>
        <span title="uploaded in total">uploaded {fmtBytes(t.uploaded)} · ratio {ratio(t.ratio)}</span>
        {#if BROWSER_ENGINE && t.peers === 0}
          <span class="quiet">no one needs pieces right now · looks for downloaders every few minutes</span>
        {:else}
          <span title="connected peers · seeds"><Users size={13} aria-hidden="true" /><span class="sr">peers and seeds: </span>{t.peers} · {t.seeds}</span>
        {/if}
        {#if t.seedEndsAt}<span title="seeding stops in"><Clock size={13} aria-hidden="true" />stops in {fmtDur((t.seedEndsAt - app.now) / 1000)}</span>{/if}
      {:else if t.state === 'metadata'}
        <span>fetching the file list from peers…</span>
      {:else if t.state === 'selecting'}
        <span>{t.fileCount ?? 0} file{t.fileCount === 1 ? '' : 's'} · choose what to download</span>
      {:else if t.state === 'paused'}
        <span>{t.fromElsewhere ? 'added on another device · resume to download it here' : finished ? 'seeding paused' : `paused at ${(t.progress * 100).toFixed(1)}%`}</span>
      {:else if t.state === 'checking'}
        <span>checking pieces…</span>
      {:else if t.state === 'error'}
        <span>{t.error ?? 'something went wrong with this torrent. try a recheck, or remove it.'}</span>
      {:else if BROWSER_ENGINE}
        <span>ready to save</span>{#if t.uploaded > 0}<span title="uploaded in total">uploaded {fmtBytes(t.uploaded)} · ratio {ratio(t.ratio)}</span>{/if}
      {:else}
        <span title="uploaded in total">uploaded {fmtBytes(t.uploaded)} · ratio {ratio(t.ratio)}</span><span>ready to download</span>
      {/if}
    </div>

    <div class="actions">
      {#if t.state === 'selecting'}
        <button type="button" class="icon-btn accent" title="choose files" aria-label="choose files" onclick={() => ui.open({ kind: 'files', hash: t.hash, intent: { seed: app.chips.seed, sequential: app.chips.sequential } })}>
          <ListChecks size={16} aria-hidden="true" />
        </button>
      {:else if t.state !== 'metadata'}
        {#if t.state === 'paused'}
          <button type="button" class="icon-btn" title="resume" aria-label="resume" onclick={() => app.act(t.hash, 'resume')}><Play size={16} aria-hidden="true" /></button>
        {:else if t.state === 'error'}
          <button type="button" class="icon-btn" title="try again" aria-label="try again" onclick={() => app.act(t.hash, 'resume')}><Play size={16} aria-hidden="true" /></button>
        {:else}
          <button type="button" class="icon-btn" title="pause" aria-label="pause" disabled={!canPause} onclick={() => app.act(t.hash, 'pause')}><Pause size={16} aria-hidden="true" /></button>
        {/if}
        <button type="button" class="icon-btn" title="force recheck" aria-label="force recheck" disabled={t.state === 'checking'} onclick={() => app.act(t.hash, 'recheck')}><RotateCcw size={16} aria-hidden="true" /></button>
        <button type="button" class="icon-btn" title={finished ? 'download' : 'available when finished'} aria-label="download" disabled={!finished || t.state === 'checking'} onclick={download}><Download size={16} aria-hidden="true" /></button>
        {#if BROWSER_ENGINE && finished && t.state !== 'checking' && t.state !== 'error'}
          <button
            type="button"
            class="icon-btn"
            class:accent={t.seed}
            title={t.seed ? 'stop seeding' : 'seed: share it from this tab'}
            aria-label={t.seed ? 'stop seeding' : 'seed'}
            aria-pressed={t.seed}
            onclick={() => app.act(t.hash, t.seed ? 'stop-seeding' : 'seed')}
          >
            <Upload size={16} aria-hidden="true" />
          </button>
        {/if}
        {#if BROWSER_ENGINE && t.playable && t.state !== 'checking'}
          <button type="button" class="icon-btn" title="play (while it downloads)" aria-label="play" onclick={() => ui.open({ kind: 'play', hash: t.hash })}><MonitorPlay size={16} aria-hidden="true" /></button>
        {/if}
        {#if BROWSER_ENGINE}
          <button type="button" class="icon-btn" title="share: magnet link and .torrent" aria-label="share" onclick={() => ui.open({ kind: 'share', hash: t.hash })}><Share2 size={16} aria-hidden="true" /></button>
        {/if}
      {/if}
      <button type="button" class="icon-btn" title="remove" aria-label="remove" onclick={() => ui.open({ kind: 'remove', hash: t.hash })}><Trash2 size={16} aria-hidden="true" /></button>
    </div>
  </div>
</article>

<style>
  .card {
    --st: var(--accent);
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-card);
    animation: rise var(--med) ease;
  }
  .st-downloading,
  .st-queued,
  .st-metadata,
  .st-selecting {
    --st: var(--accent);
  }
  .st-stalled,
  .st-checking {
    --st: var(--warn);
  }
  .st-seeding {
    --st: var(--ok);
  }
  .st-done {
    --st: var(--fg-2);
  }
  .st-paused {
    --st: var(--muted);
  }
  .st-error {
    --st: var(--err);
  }
  .top {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .title {
    flex: 1;
    min-width: 0;
  }
  .linkname {
    display: block;
    max-width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .linkname:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-color: var(--border-strong);
  }
  .name {
    font-size: 13.5px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    font-size: 12px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .pill {
    flex: none;
    font-size: 11px;
    line-height: 1;
    padding: 5px 8px;
    border-radius: 999px;
    color: var(--st);
    background: color-mix(in srgb, var(--st) 15%, transparent);
  }
  .bar {
    height: 4px;
    border-radius: 999px;
    background: var(--surface-3);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    border-radius: inherit;
    background-color: var(--st);
    transition: width 0.6s ease;
  }
  .st-downloading .fill {
    background-image: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--fg) 38%, transparent) 50%, transparent 100%);
    background-size: 200% 100%;
    animation: flow 2.2s linear infinite;
  }
  .foot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
  }
  .stats {
    flex: 1 1 200px;
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 12px;
    color: var(--fg-2);
  }
  .stats > span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .stats .quiet {
    color: var(--muted);
  }
  .stats :global(svg) {
    color: var(--muted);
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-left: auto;
  }
</style>
