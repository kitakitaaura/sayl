<script lang="ts">
  import Archive from '@lucide/svelte/icons/archive';
  import Download from '@lucide/svelte/icons/download';
  import File from '@lucide/svelte/icons/file';
  import FolderDown from '@lucide/svelte/icons/folder-down';
  import { canSaveToFolder, saveAsZip, saveToFolder } from '$lib/browser/save';
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

  // Browser engine: the whole torrent at once, into a folder (Chrome, Edge) or as one .zip.
  const folderOk = canSaveToFolder();
  let saving = $state<{ what: 'folder' | 'zip'; progress: number } | null>(null);
  let controller: AbortController | null = null;

  async function saveAll(what: 'folder' | 'zip') {
    if (saving) return;
    controller = new AbortController();
    saving = { what, progress: 0 };
    try {
      const { name: top, files } = await app.finishedFiles(hash);
      const progress = (p: number) => saving && (saving.progress = p);
      if (what === 'folder') {
        if (await saveToFolder(files, progress, controller.signal)) toasts.push(`saved ${files.length} file${files.length === 1 ? '' : 's'}`, 'ok');
      } else {
        await saveAsZip(top, files, progress, controller.signal);
      }
      app.downloaded(hash);
    } catch (err) {
      if (!controller?.signal.aborted) toasts.push(errorMessage(err), 'err');
    } finally {
      saving = null;
      controller = null;
    }
  }

  function close() {
    controller?.abort();
    onclose();
  }
</script>

<Dialog title="download" subtitle={torrent?.name ?? ''} onclose={close}>
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
      {#if saving}
        <span class="note" role="status">{saving.what === 'zip' ? 'preparing the zip' : 'saving to the folder'}… {Math.round(saving.progress * 100)}%</span>
      {:else}
        <span class="note">files save straight from your browser's storage.</span>
      {/if}
      {#if links && links.files.length > 1}
        {#if folderOk}
          <button type="button" class="btn" disabled={!!saving} onclick={() => saveAll('folder')}><FolderDown size={16} aria-hidden="true" />save to a folder</button>
        {/if}
        <button type="button" class="btn primary" data-autofocus disabled={!!saving} onclick={() => saveAll('zip')}><Archive size={16} aria-hidden="true" />download .zip</button>
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
