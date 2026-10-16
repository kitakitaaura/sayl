<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Gate from '$lib/components/Gate.svelte';
  import Omnibox from '$lib/components/Omnibox.svelte';
  import RelaySetup from '$lib/components/RelaySetup.svelte';
  import TorrentCard from '$lib/components/TorrentCard.svelte';
  import Wordmark from '$lib/components/Wordmark.svelte';
  import { ABUSE_EMAIL, APP_NAME, BROWSER_ENGINE } from '$lib/config';
  import { app } from '$lib/state/app.svelte';
  import { settings } from '$lib/state/settings.svelte';

  let fileInput: HTMLInputElement;

  const allChips = [
    { key: 'sequential', label: 'sequential' },
    { key: 'seed', label: 'seed after' },
    { key: 'select', label: 'select files' },
  ] as const;
  // the browser engine doesn't upload yet, so it can't seed
  const chips = BROWSER_ENGINE ? allChips.filter((c) => c.key !== 'seed') : allChips;

  function toggle(key: (typeof allChips)[number]['key']) {
    app.chips[key] = !app.chips[key];
    if (key === 'select') settings.set('selectFiles', app.chips.select);
  }

  async function picked() {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) await app.addFile(file);
  }
</script>

<svelte:head>
  <title>{APP_NAME}</title>
</svelte:head>

<div class="page">
  <div class="col">
    <h1 class="sr">{APP_NAME}</h1>
    <Wordmark />
    {#if app.status === 'gate'}
      <Gate />
    {:else if app.status === 'setup'}
      <RelaySetup />
    {:else if app.status === 'unsupported'}
      <p class="status" role="alert">this browser can’t store downloads. use a current version of chrome, edge, firefox or safari.</p>
    {:else if app.status === 'banned'}
      <p class="status" role="alert">access from your network has been blocked. if you think this is a mistake, contact <span class="mono">{ABUSE_EMAIL}</span>.</p>
    {:else}
    <Omnibox />
    <div class="chips" role="group" aria-label="options">
      {#each chips as c (c.key)}
        <button type="button" class="chip" role="switch" aria-checked={app.chips[c.key]} onclick={() => toggle(c.key)}>
          <span class="tick"><Check size={12} strokeWidth={3} aria-hidden="true" /></span>{c.label}
        </button>
      {/each}
    </div>
    <p class="hint">
      or drop a .torrent file anywhere ·
      <button type="button" class="linkish" onclick={() => fileInput.click()}>choose one</button>
    </p>
    <input bind:this={fileInput} type="file" accept=".torrent,application/x-bittorrent" hidden onchange={picked} />

    {#if app.status === 'offline'}
      <p class="status" role="status">can't reach {APP_NAME.toLowerCase()} right now. retrying…</p>
    {/if}

    {#if app.visible.length}
      <section class="list" aria-label="your torrents">
        {#each app.visible as t (t.hash)}
          <TorrentCard {t} />
        {/each}
      </section>
    {/if}
    {/if}
  </div>
</div>

<style>
  .chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 12px 0 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--fg-2);
    font-size: 12.5px;
  }
  .tick {
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
  .chip[aria-checked='true'] {
    color: var(--fg);
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
    background: var(--accent-soft);
  }
  .chip[aria-checked='true'] .tick {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
  }
  .hint {
    margin: 0;
    text-align: center;
    font-size: 12px;
    color: var(--muted);
  }
  .linkish {
    padding: 0;
    border: 0;
    background: none;
    color: var(--fg-2);
    font-size: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
    text-decoration-color: var(--border-strong);
  }
  .linkish:hover {
    color: var(--fg);
  }
  .status {
    margin: 0;
    text-align: center;
    font-size: 12.5px;
    color: var(--warn);
  }
  .mono {
    color: var(--fg);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
  }
</style>
