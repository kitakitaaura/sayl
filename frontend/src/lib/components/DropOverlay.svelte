<script lang="ts">
  /** Accepts a .torrent dropped anywhere on the page. */
  import FileUp from '@lucide/svelte/icons/file-up';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';

  let depth = $state(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

  function dragenter(e: DragEvent) {
    if (!hasFiles(e) || ui.dialog) return;
    e.preventDefault();
    depth++;
  }
  function dragover(e: DragEvent) {
    if (hasFiles(e)) e.preventDefault();
  }
  function dragleave(e: DragEvent) {
    if (hasFiles(e)) depth = Math.max(0, depth - 1);
  }
  async function drop(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    const file = e.dataTransfer?.files[0];
    if (!file || ui.dialog) return;
    if (page.url.pathname !== '/') await goto('/');
    await app.addFile(file);
  }
</script>

<svelte:window ondragenter={dragenter} ondragover={dragover} ondragleave={dragleave} ondrop={drop} />

{#if depth > 0}
  <div class="drop" aria-hidden="true">
    <div class="box">
      <FileUp size={28} />
      <b>drop to add torrent</b>
      <span>.torrent files only</span>
    </div>
  </div>
{/if}

<style>
  .drop {
    position: fixed;
    inset: 0;
    z-index: 70;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--backdrop);
    animation: fade var(--fast) ease;
    pointer-events: none;
  }
  .box {
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 48px 24px;
    border: 2px dashed color-mix(in srgb, var(--accent) 70%, transparent);
    border-radius: 24px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    text-align: center;
  }
  .box :global(svg) {
    color: var(--accent);
  }
  b {
    font-weight: 500;
  }
  span {
    font-size: 12px;
    color: var(--muted);
  }
</style>
