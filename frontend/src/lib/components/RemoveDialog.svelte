<script lang="ts">
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import { fmtDur, keepHours } from '$lib/format';
  import { BROWSER_ENGINE } from '$lib/config';
  import { app } from '$lib/state/app.svelte';
  import Dialog from './Dialog.svelte';

  let { hash, onclose }: { hash: string; onclose: () => void } = $props();

  const t = $derived(app.find(hash));
  const left = $derived.by(() => {
    if (!t || t.completedAt === null || t.selectedSize === null) return null;
    const h = keepHours(t.selectedSize, app.limits);
    return h === null ? null : (t.completedAt + h * 3600_000 - app.now) / 1000;
  });

  // read the props before closing: once the dialog is gone they no longer resolve
  async function stopSeeding() {
    const h = hash;
    onclose();
    await app.act(h, 'stop-seeding');
  }

  async function remove() {
    const h = hash;
    onclose();
    await app.remove(h);
  }
</script>

<Dialog title="remove torrent" subtitle={t?.name ?? ''} small {onclose}>
  <p class="text">
    {#if t?.state === 'seeding'}
      stop seeding and keep the files to download{left !== null ? ` for ${fmtDur(left)}` : ''}, or delete everything now.
    {:else if t && (t.progress >= 1 || t.completedAt !== null)}
      this deletes the files {BROWSER_ENGINE ? "from your browser's storage" : 'now'}. files you already saved stay where you saved them.
    {:else}
      this deletes the torrent and everything downloaded so far.
    {/if}
  </p>
  {#snippet footer()}
    {#if t?.state === 'seeding'}
      <button type="button" class="btn" onclick={stopSeeding}>stop seeding, keep files</button>
    {:else}
      <button type="button" class="btn" onclick={onclose}>cancel</button>
    {/if}
    <button type="button" class="btn danger" data-autofocus onclick={remove}><Trash2 size={16} aria-hidden="true" />delete files</button>
  {/snippet}
</Dialog>

<style>
  .text {
    margin: 0;
    padding: 0 16px 14px;
    font-size: 13px;
    color: var(--fg-2);
  }
</style>
