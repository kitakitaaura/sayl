<script lang="ts">
  /**
   * Browser engine: plays a video or audio file while it downloads. The player reads /stream/…, which the
   * service worker answers from the torrent's storage; parts not in yet are fetched first, then played.
   */
  import { onMount } from 'svelte';
  import type { FileView } from '$lib/api';
  import { fmtBytes } from '$lib/format';
  import { isAudio, mediaType } from '$lib/media';
  import { app, errorMessage } from '$lib/state/app.svelte';
  import Dialog from './Dialog.svelte';

  let { hash, onclose }: { hash: string; onclose: () => void } = $props();

  const torrent = $derived(app.find(hash));
  let files = $state<FileView[]>([]);
  let chosen = $state<number | null>(null);
  let problem = $state('');
  // the service worker that answers the player; none on the very first visit until a reload
  let ready = $state<boolean | null>(null);

  const name = (path: string) => path.split('/').pop() ?? path;
  const file = $derived(files.find((f) => f.index === chosen) ?? null);
  const src = $derived(file ? `/stream/${hash}/${file.index}/${encodeURIComponent(name(file.path))}` : '');

  onMount(() => {
    void (async () => {
      try {
        files = (await app.files(hash)).filter((f) => f.selected && mediaType(f.path));
        // the biggest one is usually the one to watch
        chosen = [...files].sort((a, b) => b.size - a.size)[0]?.index ?? null;
      } catch (err) {
        problem = errorMessage(err);
      }
      if (!('serviceWorker' in navigator)) return void (ready = false);
      await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 4000))]);
      ready = !!navigator.serviceWorker.controller;
    })();
  });

  function failed() {
    problem = "your browser can't play this file (its format or codec isn't supported here). save it and open it in a video player instead.";
  }
</script>

<Dialog title="play" subtitle={torrent?.name ?? ''} {onclose}>
  <div class="body">
    {#if files.length > 1}
      <label class="lbl" for="play-file">file</label>
      <select id="play-file" bind:value={chosen} onchange={() => (problem = '')}>
        {#each files as f (f.index)}<option value={f.index}>{f.path} · {fmtBytes(f.size)}</option>{/each}
      </select>
    {/if}
    {#if ready === false}
      <p class="text">playing needs one reload of this page (it sets up the player the first time).</p>
      <button type="button" class="btn" onclick={() => location.reload()}>reload</button>
    {:else if ready && file}
      {#key src}
        {#if isAudio(file.path)}
          <audio controls autoplay {src} onerror={failed}></audio>
        {:else}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video controls autoplay playsinline {src} onerror={failed}></video>
        {/if}
      {/key}
      <p class="muted">
        {Math.round(file.progress * 100)}% downloaded. parts that aren't in yet are fetched first when you play or skip to them, so it may pause
        for a moment.
      </p>
    {:else if ready && !files.length && !problem}
      <p class="text">no playable files in this torrent.</p>
    {/if}
    {#if problem}<p class="error" role="alert">{problem}</p>{/if}
  </div>
  {#snippet footer()}
    <button type="button" class="btn" onclick={onclose}>done</button>
  {/snippet}
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0 16px 14px;
  }
  video {
    width: 100%;
    max-height: 60vh;
    border-radius: 12px;
    background: #000;
  }
  audio {
    width: 100%;
  }
  select {
    height: 38px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    color: var(--fg);
  }
  .lbl,
  .muted {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
  }
  .text {
    margin: 0;
    font-size: 13px;
    color: var(--fg-2);
  }
  .error {
    margin: 0;
    font-size: 12.5px;
    color: var(--err);
  }
</style>
