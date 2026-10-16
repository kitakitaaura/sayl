<script lang="ts">
  /** Browser engine: makes a torrent from the visitor's own files, then seeds it from this tab. */
  import Share2 from '@lucide/svelte/icons/share-2';
  import { APP_NAME } from '$lib/config';
  import { fmtBytes } from '$lib/format';
  import { app } from '$lib/state/app.svelte';
  import { settings } from '$lib/state/settings.svelte';
  import type { PickedFile } from '$lib/state/ui.svelte';
  import Dialog from './Dialog.svelte';
  import ShareLinks from './ShareLinks.svelte';

  let { entries, onclose }: { entries: PickedFile[]; onclose: () => void } = $props();

  // One folder picked or dropped: the torrent is named after it, and paths are inside it.
  // Loose files: they sit at the top of a folder the visitor names.
  const parts = $derived(entries.map((e) => e.path.split('/').filter(Boolean)));
  const top = $derived.by(() => {
    const first = parts[0]?.[0];
    return first && parts.every((p) => p.length > 1 && p[0] === first) ? first : null;
  });
  const files = $derived(entries.map((e, i) => ({ file: e.file, path: top ? parts[i].slice(1) : parts[i] })));
  const single = $derived(files.length === 1);
  const total = $derived(entries.reduce((n, e) => n + e.file.size, 0));

  // svelte-ignore state_referenced_locally
  let name = $state(top ?? (entries.length === 1 ? (entries[0]?.file.name ?? '') : `${APP_NAME.toLowerCase()} share`));
  let phase = $state<'ready' | 'working' | 'done'>('ready');
  let progress = $state(0);
  let result = $state<{ magnet: string; torrent: Uint8Array } | null>(null);
  let controller: AbortController | null = null;

  async function make(e: SubmitEvent) {
    e.preventDefault();
    phase = 'working';
    progress = 0;
    controller = new AbortController();
    const r = await app.create(files, name.trim(), (f) => (progress = f), controller.signal);
    controller = null;
    if (r) {
      result = r;
      phase = 'done';
    } else {
      phase = 'ready';
    }
  }

  function close() {
    controller?.abort();
    onclose();
  }
</script>

<Dialog title={phase === 'done' ? 'sharing' : 'share files'} subtitle={single ? (entries[0]?.file.name ?? '') : `${entries.length} files · ${fmtBytes(total)}`} onclose={close}>
  <div class="body">
    {#if phase === 'done' && result}
      <p class="text">
        seeding from this tab now. anyone with this link can download the files from you while this tab is open. it stops once you've
        uploaded {settings.prefs.ratio}× the files' size (the ratio limit in settings), or when you close the tab.
      </p>
      <ShareLinks name={single ? (entries[0]?.file.name ?? name) : name.trim()} magnet={result.magnet} torrent={result.torrent} />
    {:else}
      <form id="create-form" class="form" onsubmit={make}>
        {#if single}
          <p class="text">{fmtBytes(total)}. the torrent is named after the file.</p>
        {:else}
          <label class="lbl" for="share-name">name</label>
          <input id="share-name" type="text" required maxlength="200" bind:value={name} disabled={phase === 'working'} />
        {/if}
      </form>
      <p class="text">
        {APP_NAME.toLowerCase()} makes a torrent, copies the files into this browser's storage and seeds them while this tab is open. only share
        files you have the right to share.
      </p>
      {#if phase === 'working'}
        <div class="bar" role="progressbar" aria-label="making the torrent" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progress * 100)}>
          <div class="fill" style="width: {progress * 100}%"></div>
        </div>
        <p class="muted" role="status">{progress < 0.5 ? 'reading and hashing…' : 'copying into browser storage…'} {Math.round(progress * 100)}%</p>
      {/if}
    {/if}
  </div>

  {#snippet footer()}
    {#if phase === 'done'}
      <button type="button" class="btn" onclick={close}>done</button>
    {:else}
      <button type="button" class="btn" onclick={close}>cancel</button>
      <button type="submit" form="create-form" class="btn primary" data-autofocus disabled={phase === 'working' || (!single && !name.trim())}>
        <Share2 size={16} aria-hidden="true" />make torrent
      </button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 0 16px 14px;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .text,
  .muted {
    margin: 0;
    font-size: 13px;
    color: var(--fg-2);
  }
  .muted {
    font-size: 12px;
    color: var(--muted);
  }
  .lbl {
    font-size: 12px;
    color: var(--muted);
  }
  input {
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    color: var(--fg);
  }
  .bar {
    height: 6px;
    border-radius: 999px;
    background: var(--border);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    transition: width var(--fast) linear;
  }
</style>
