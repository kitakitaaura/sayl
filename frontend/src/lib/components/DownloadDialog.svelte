<script lang="ts">
  import Archive from '@lucide/svelte/icons/archive';
  import Download from '@lucide/svelte/icons/download';
  import File from '@lucide/svelte/icons/file';
  import type { Links } from '$lib/api';
  import { BROWSER_ENGINE } from '$lib/config';
  import { fmtBytes } from '$lib/format';
  import { app, errorMessage } from '$lib/state/app.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import Dialog from './Dialog.svelte';

  let { hash, onclose }: { hash: string; onclose: () => void } = $props();

  const torrent = $derived(app.find(hash));
  let links = $state<Links | null>(null);

  $effect(() => {
    const h = hash;
    app
      .links(h)
      .then((l) => (links = l))
      .catch((err) => {
        toasts.push(errorMessage(err), 'err');
        onclose();
      });
  });

  const name = (path: string) => path.split('/').pop() ?? path;

  /** Browser engine: saves every file, one after another (the browser may ask to allow several downloads). */
  async function saveAll() {
    if (!links) return;
    for (const f of links.files) {
      const a = document.createElement('a');
      a.href = f.url;
      a.download = name(f.path);
      a.click();
      await new Promise((r) => setTimeout(r, 400));
    }
    app.downloaded(hash);
  }
</script>

<Dialog title="download" subtitle={torrent?.name ?? ''} {onclose}>
  <div class="body">
    {#if !links}
      <p class="muted" role="status">getting your links…</p>
    {:else if !links.files.length}
      <p class="muted">nothing has finished yet.</p>
    {:else}
      {#each links.files as f (f.index)}
        <div class="row">
          <File class="ft" size={15} aria-hidden="true" />
          <span class="nm" title={f.path}>{name(f.path)}</span>
          <span class="sz tabular">{fmtBytes(f.size)}</span>
          <a class="icon-btn" href={f.url} rel="noopener" download={BROWSER_ENGINE ? name(f.path) : undefined} aria-label="download {name(f.path)}" onclick={() => app.downloaded(hash)}>
            <Download size={16} aria-hidden="true" />
          </a>
        </div>
      {/each}
    {/if}
  </div>

  {#snippet footer()}
    {#if BROWSER_ENGINE}
      <span class="note">files save straight from your browser's storage.</span>
      {#if links && links.files.length > 1}
        <button type="button" class="btn primary" data-autofocus onclick={saveAll}><Archive size={16} aria-hidden="true" />save all</button>
      {/if}
    {:else}
      <span class="note">the zip streams right away. links last 6 hours.</span>
    {/if}
    {#if links?.zip}
      <a class="btn primary" href={links.zip.url} rel="noopener" data-autofocus onclick={() => app.downloaded(hash)}>
        <Archive size={16} aria-hidden="true" />download all (.zip)
      </a>
    {/if}
  {/snippet}
</Dialog>

<style>
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 8px;
  }
  .muted {
    margin: 0;
    padding: 8px 8px 16px;
    color: var(--muted);
    font-size: 13px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 4px 8px;
    border-radius: 10px;
  }
  .row:hover {
    background: var(--surface-2);
  }
  .row :global(.ft) {
    flex: none;
    color: var(--muted);
  }
  .nm {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sz {
    flex: none;
    font-size: 12px;
    color: var(--muted);
  }
  .note {
    margin-right: auto;
    font-size: 12px;
    color: var(--muted);
  }
</style>
