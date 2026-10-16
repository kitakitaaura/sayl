<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Download from '@lucide/svelte/icons/download';
  import File from '@lucide/svelte/icons/file';
  import Folder from '@lucide/svelte/icons/folder';
  import Minus from '@lucide/svelte/icons/minus';
  import { SvelteSet } from 'svelte/reactivity';
  import type { FileView } from '$lib/api';
  import { BROWSER_ENGINE } from '$lib/config';
  import { fmtBytes, keepHours } from '$lib/format';
  import { app, errorMessage } from '$lib/state/app.svelte';
  import { toasts } from '$lib/state/toasts.svelte';
  import type { Intent } from '$lib/state/ui.svelte';
  import Dialog from './Dialog.svelte';

  let { hash, intent, onclose }: { hash: string; intent: Intent; onclose: () => void } = $props();

  interface Node {
    key: string;
    name: string;
    depth: number;
    /** file indexes under this node */
    leaves: number[];
    size: number;
    file?: FileView;
    children: Node[];
  }

  const torrent = $derived(app.find(hash));
  let files = $state<FileView[] | null>(null);
  let loading = false;
  const selected = new SvelteSet<number>();
  const collapsed = new SvelteSet<string>();
  let saving = $state(false);

  // load the file list once metadata is in
  $effect(() => {
    const state = torrent?.state;
    if (!torrent) {
      onclose();
      return;
    }
    if (files || loading || state === 'metadata') return;
    if (state !== 'selecting') {
      toasts.push('files are already picked for this torrent', 'info');
      onclose();
      return;
    }
    loading = true;
    app
      .files(hash)
      .then((list) => {
        files = list;
        for (const f of list) selected.add(f.index);
      })
      .catch((err) => {
        toasts.push(errorMessage(err), 'err');
        onclose();
      });
  });

  const tree = $derived.by(() => {
    const root: Node = { key: '', name: '', depth: -1, leaves: [], size: 0, children: [] };
    for (const f of files ?? []) {
      const parts = f.path.split('/');
      let node = root;
      parts.forEach((part, i) => {
        node.leaves.push(f.index);
        node.size += f.size;
        const key = parts.slice(0, i + 1).join('/');
        let child = node.children.find((c) => c.key === key);
        if (!child) {
          child = { key, name: part, depth: i, leaves: [], size: 0, children: [] };
          node.children.push(child);
        }
        node = child;
      });
      node.leaves.push(f.index);
      node.size += f.size;
      node.file = f;
    }
    return root;
  });

  const rows = $derived.by(() => {
    const out: Node[] = [];
    const walk = (n: Node) => {
      for (const c of n.children) {
        out.push(c);
        if (c.children.length && !collapsed.has(c.key)) walk(c);
      }
    };
    walk(tree);
    return out;
  });

  const total = $derived(files?.length ?? 0);
  const pickedSize = $derived((files ?? []).filter((f) => selected.has(f.index)).reduce((s, f) => s + f.size, 0));
  const hours = $derived(keepHours(pickedSize, app.limits));
  // the server caps sizes; the browser engine checks the browser's free storage when the download starts
  const tooBig = $derived(!BROWSER_ENGINE && pickedSize > 0 && (hours === null || pickedSize > (app.limits?.maxTorrentGb ?? Infinity) * 1e9));

  function toggle(n: Node) {
    const all = n.leaves.every((i) => selected.has(i));
    for (const i of n.leaves) all ? selected.delete(i) : selected.add(i);
  }

  function indeterminate(el: HTMLInputElement, value: boolean) {
    el.indeterminate = value;
    return { update: (v: boolean) => (el.indeterminate = v) };
  }

  async function start() {
    if (!selected.size || tooBig || saving) return;
    saving = true;
    const ok = await app.select(hash, [...selected].sort((a, b) => a - b), intent);
    saving = false;
    if (ok) onclose();
  }
</script>

<Dialog title="select files" subtitle={torrent?.name ?? ''} {onclose}>
  {#if !files}
    <div class="loading" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <span>fetching the file list…</span>
      <small>magnet links can take a minute to find peers. you can close this and pick files later from the card.</small>
    </div>
  {:else}
    <div class="tools">
      <button type="button" class="btn sm" onclick={() => files?.forEach((f) => selected.add(f.index))}>all</button>
      <button type="button" class="btn sm" onclick={() => selected.clear()}>none</button>
      <span class="sum tabular">{selected.size} of {total} file{total === 1 ? '' : 's'} · {fmtBytes(pickedSize)}</span>
    </div>
    <div class="body" role="group" aria-label="files">
      {#each rows as n (n.key)}
        {@const all = n.leaves.every((i) => selected.has(i))}
        {@const some = !all && n.leaves.some((i) => selected.has(i))}
        <div class="node" style="--d: {n.depth}">
          {#if n.children.length}
            <button
              type="button"
              class="tw"
              aria-expanded={!collapsed.has(n.key)}
              aria-label="{collapsed.has(n.key) ? 'expand' : 'collapse'} {n.name}"
              onclick={() => (collapsed.has(n.key) ? collapsed.delete(n.key) : collapsed.add(n.key))}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          {:else}
            <span class="tw-sp"></span>
          {/if}
          <label class="cb">
            <input type="checkbox" checked={all} use:indeterminate={some} onchange={() => toggle(n)} />
            <span class="box"><span class="chk"><Check size={12} strokeWidth={3} aria-hidden="true" /></span><span class="dash"><Minus size={12} strokeWidth={3} aria-hidden="true" /></span></span>
            {#if n.children.length}<Folder class="ft" size={15} aria-hidden="true" />{:else}<File class="ft" size={15} aria-hidden="true" />{/if}
            <span class="nm" title={n.key}>{n.name}</span>
          </label>
          <span class="sz tabular">{fmtBytes(n.size)}</span>
        </div>
      {/each}
    </div>
  {/if}

  {#snippet footer()}
    <span class="tier" class:bad={tooBig}>
      {#if !files}
        waiting for metadata
      {:else if !selected.size}
        pick at least one file
      {:else if tooBig}
        too big · max {app.limits?.maxTorrentGb ?? 20} gb per torrent
      {:else if BROWSER_ENGINE}
        saved in your browser until you remove it
      {:else if hours !== null}
        kept {hours}h after it finishes
      {/if}
    </span>
    <button type="button" class="btn primary" data-autofocus disabled={!files || !selected.size || tooBig || saving} onclick={start}>
      <Download size={16} aria-hidden="true" />download selected
    </button>
  {/snippet}
</Dialog>

<style>
  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 32px 24px 40px;
    color: var(--muted);
    font-size: 12.5px;
    text-align: center;
  }
  .loading small {
    max-width: 32ch;
    font-size: 11.5px;
  }
  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 16px 8px;
    font-size: 12px;
    color: var(--muted);
  }
  .sum {
    margin-left: auto;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 8px;
  }
  .node {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 4px 8px 4px calc(8px + var(--d, 0) * 20px);
    border-radius: 10px;
  }
  .node:hover {
    background: var(--surface-2);
  }
  .tw {
    flex: none;
    width: 20px;
    height: 20px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
  }
  .tw :global(svg) {
    transition: transform var(--fast) ease;
  }
  .tw[aria-expanded='false'] :global(svg) {
    transform: rotate(-90deg);
  }
  .tw-sp {
    flex: none;
    width: 20px;
  }
  .cb {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }
  .cb input {
    position: absolute;
    left: 0;
    top: 50%;
    width: 16px;
    height: 16px;
    margin: -8px 0 0;
    opacity: 0;
  }
  .box {
    flex: none;
    width: 16px;
    height: 16px;
    border-radius: 5px;
    border: 1.5px solid var(--border-strong);
    display: grid;
    place-items: center;
    color: transparent;
    transition:
      background-color var(--fast),
      border-color var(--fast);
  }
  .box span {
    display: grid;
  }
  .dash {
    display: none !important;
  }
  .cb input:checked + .box,
  .cb input:indeterminate + .box {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .cb input:indeterminate + .box .chk {
    display: none;
  }
  .cb input:indeterminate + .box .dash {
    display: grid !important;
  }
  .cb input:focus-visible + .box {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .cb :global(.ft) {
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
  .tier {
    margin-right: auto;
    font-size: 12px;
    color: var(--muted);
  }
  .tier.bad {
    color: var(--err);
  }
</style>
