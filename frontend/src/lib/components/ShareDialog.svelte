<script lang="ts">
  /** Browser engine: a torrent's magnet link and .torrent file, to pass on. */
  import { app } from '$lib/state/app.svelte';
  import Dialog from './Dialog.svelte';
  import ShareLinks from './ShareLinks.svelte';

  let { hash, onclose }: { hash: string; onclose: () => void } = $props();

  const t = $derived(app.find(hash));
  // svelte-ignore state_referenced_locally
  const links = app.share(hash);
</script>

<Dialog title="share" subtitle={t?.name ?? ''} {onclose}>
  <div class="body">
    <p class="text">
      {#if t?.state === 'seeding'}
        seeding from this tab: anyone with this link can download from you while it's open.
      {:else}
        you aren't seeding this, so others will get it from other peers. press seed on the card to share it from this tab too.
      {/if}
    </p>
    {#if links}<ShareLinks name={links.name} magnet={links.magnet} torrent={links.torrent} />{/if}
  </div>
  {#snippet footer()}
    <button type="button" class="btn" onclick={onclose}>done</button>
  {/snippet}
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 0 16px 14px;
  }
  .text {
    margin: 0;
    font-size: 13px;
    color: var(--fg-2);
  }
</style>
