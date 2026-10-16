<script lang="ts">
  /**
   * Accepts a .torrent dropped anywhere on the page. In the browser version, other files and
   * folders open "share files" instead.
   */
  import FileUp from '@lucide/svelte/icons/file-up';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { BROWSER_ENGINE } from '$lib/config';
  import { app } from '$lib/state/app.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import { ui, type PickedFile } from '$lib/state/ui.svelte';

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
    const dt = e.dataTransfer;
    if (!dt || ui.dialog) return;
    // read everything now: the drop's data is gone after the first await
    const files = [...dt.files];
    const entries = BROWSER_ENGINE ? [...dt.items].map((i) => i.webkitGetAsEntry?.() ?? null) : [];
    if (!files.length) return;
    if (page.url.pathname !== '/') await goto('/');
    const oneTorrent = files.length === 1 && /\.torrent$/i.test(files[0].name) && !entries[0]?.isDirectory;
    if (!BROWSER_ENGINE || oneTorrent) {
      await app.addFile(files[0]);
      return;
    }
    if (app.status !== 'ready') {
      toasts.push('set up your relay first, then drop the files again', 'info');
      return;
    }
    let picked: PickedFile[];
    try {
      picked = await collect(entries, files);
    } catch {
      toasts.push("couldn't read what was dropped. try “share your files” instead.", 'err');
      return;
    }
    if (picked.length) ui.open({ kind: 'create', entries: picked });
    else toasts.push('nothing to share in there', 'info');
  }

  /** Every file dropped, with folders walked, each with its path from what was dropped. */
  async function collect(entries: (FileSystemEntry | null)[], files: File[]): Promise<PickedFile[]> {
    if (!entries.length || entries.some((x) => !x)) return files.map((file) => ({ file, path: file.name }));
    const out: PickedFile[] = [];
    const walk = async (entry: FileSystemEntry): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        out.push({ file, path: entry.fullPath.replace(/^\/+/, '') });
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          for (const child of batch) await walk(child);
        }
      }
    };
    for (const entry of entries) await walk(entry!);
    return out;
  }
</script>

<svelte:window ondragenter={dragenter} ondragover={dragover} ondragleave={dragleave} ondrop={drop} />

{#if depth > 0}
  <div class="drop" aria-hidden="true">
    <div class="box">
      <FileUp size={28} />
      {#if BROWSER_ENGINE}
        <b>drop to add or share</b>
        <span>a .torrent file is added; other files and folders are shared</span>
      {:else}
        <b>drop to add torrent</b>
        <span>.torrent files only</span>
      {/if}
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
