<script lang="ts">
  /** A notice when the visitor's relay is older than the one this site installs, with the way to update it. */
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { onMount } from 'svelte';
  import { RELAY_VERSION } from '$lib/config';
  import { relayConfig } from '$lib/browser/relay.svelte';

  const KEY = 'sayl.relay-update-later';
  let later = $state(false);

  onMount(() => {
    void relayConfig.checkAvailable();
    try {
      later = sessionStorage.getItem(KEY) === String(RELAY_VERSION);
    } catch {
      // storage blocked: the notice just shows
    }
  });

  function dismiss() {
    later = true;
    try {
      sessionStorage.setItem(KEY, String(RELAY_VERSION));
    } catch {
      // storage blocked
    }
  }
</script>

{#if relayConfig.outdated && !later}
  <div class="notice" role="status">
    <p>
      <b>your relay is out of date</b> (version {relayConfig.version}; the latest is {RELAY_VERSION}). updating brings the latest fixes and keeps
      your address and token.
    </p>
    {#if relayConfig.available}
      <div class="row">
        <button type="button" class="btn primary sm" onclick={() => relayConfig.connect()}><RefreshCw size={14} aria-hidden="true" />update with cloudflare</button>
        <button type="button" class="btn sm" onclick={dismiss}>later</button>
      </div>
      <p class="small">set it up by hand? in the project's <span class="mono">relay</span> folder: <span class="mono">git pull</span>, then <span class="mono">npx wrangler deploy</span>.</p>
    {:else}
      <p class="small">in the project's <span class="mono">relay</span> folder: <span class="mono">git pull</span>, then <span class="mono">npx wrangler deploy</span>.</p>
      <div class="row"><button type="button" class="btn sm" onclick={dismiss}>later</button></div>
    {/if}
  </div>
{/if}

<style>
  .notice {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    border-radius: var(--r-box);
    background: var(--accent-soft);
    font-size: 12.5px;
    color: var(--fg-2);
  }
  p {
    margin: 0;
  }
  b {
    color: var(--fg);
    font-weight: 600;
  }
  .row {
    display: flex;
    gap: 8px;
  }
  .small {
    font-size: 12px;
    color: var(--muted);
  }
  .mono {
    font-family: var(--mono);
    color: var(--fg-2);
  }
</style>
