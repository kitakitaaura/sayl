<script lang="ts">
  /** A torrent's magnet link (to copy) and its .torrent file (to save). */
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import FileDown from '@lucide/svelte/icons/file-down';
  import { toasts } from '$lib/state/toasts.svelte';

  let { name, magnet, torrent }: { name: string; magnet: string; torrent: Uint8Array | null } = $props();

  let copied = $state(false);
  let field: HTMLInputElement;

  async function copy() {
    try {
      await navigator.clipboard.writeText(magnet);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      field.select();
      toasts.push('select the link and copy it', 'info');
    }
  }

  function save() {
    if (!torrent) return;
    const url = URL.createObjectURL(new Blob([torrent as BlobPart], { type: 'application/x-bittorrent' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.torrent`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
</script>

<div class="links">
  <label class="lbl" for="share-magnet">magnet link</label>
  <div class="row">
    <input id="share-magnet" bind:this={field} class="mono" type="text" readonly value={magnet} onfocus={() => field.select()} />
    <button type="button" class="btn primary" data-autofocus onclick={copy}>
      {#if copied}<Check size={16} aria-hidden="true" />copied{:else}<Copy size={16} aria-hidden="true" />copy{/if}
    </button>
  </div>
  {#if torrent}
    <button type="button" class="btn" onclick={save}><FileDown size={16} aria-hidden="true" />save .torrent file</button>
  {/if}
</div>

<style>
  .links {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .lbl {
    font-size: 12px;
    color: var(--muted);
  }
  .row {
    display: flex;
    gap: 8px;
    width: 100%;
  }
  input {
    flex: 1;
    min-width: 0;
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    color: var(--fg-2);
    font-size: 12px;
  }
  .mono {
    font-family: var(--mono);
  }
</style>
