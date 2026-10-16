<script lang="ts">
  /**
   * Asks for the visitor's relay: the free Cloudflare Worker that carries their
   * BitTorrent connections. Shown on the home page until one is set, and in settings.
   */
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Link from '@lucide/svelte/icons/link';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import { APP_NAME } from '$lib/config';
  import { normalizeRelayUrl, relayConfig } from '$lib/browser/relay.svelte';
  import { app } from '$lib/state/app.svelte';
  import { toasts } from '$lib/state/toasts.svelte';

  let { compact = false }: { compact?: boolean } = $props();

  const name = APP_NAME.toLowerCase();
  let url = $state(relayConfig.url);
  let token = $state(relayConfig.token);
  let busy = $state(false);
  let error = $state('');

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = '';
    const clean = normalizeRelayUrl(url);
    if (!clean) {
      error = 'that doesn’t look like a relay address. it starts with https://';
      return;
    }
    busy = true;
    const r = await relayConfig.test(clean, token.trim());
    busy = false;
    if (r.error) {
      error = r.error;
      return;
    }
    relayConfig.save(clean, token.trim());
    url = clean;
    app.relaySaved();
    toasts.push(r.dht ? 'relay connected' : 'relay connected. it has no TURN login, so torrents found only through the DHT won’t start.', r.dht ? 'ok' : 'info');
  }

  function forget() {
    relayConfig.save('', '');
    url = '';
    token = '';
    app.relaySaved();
  }
</script>

{#if !compact}
  <p class="note">
    {name} runs torrents right here in your browser. it needs a <b>relay</b>: a small free program on your own cloudflare account that connects
    your browser to other peers. paste its address below.
  </p>
{/if}

<form class="box" onsubmit={submit} aria-label="relay">
  <div class="omni">
    <Link class="lead" size={18} aria-hidden="true" />
    <label class="sr" for="relay-url">relay address</label>
    <input id="relay-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://sayl-relay.you.workers.dev" bind:value={url} />
  </div>
  <div class="omni">
    <KeyRound class="lead" size={18} aria-hidden="true" />
    <label class="sr" for="relay-token">relay token</label>
    <input id="relay-token" type="password" autocomplete="off" placeholder="token (if your relay has one)" bind:value={token} />
    <button type="submit" class="go" aria-label="save relay" disabled={busy}><ArrowRight size={18} aria-hidden="true" /></button>
  </div>
</form>

{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if compact && relayConfig.ready}
  <p class="hint">using <span class="mono">{relayConfig.url}</span> · <button type="button" class="linkish" onclick={forget}>forget it</button></p>
{:else if !compact}
  <p class="hint">no relay yet? the setup guide is in the project’s <span class="mono">relay/README.md</span>. it takes about five minutes and is free.</p>
{/if}

<style>
  .note {
    margin: 0;
    text-align: center;
    font-size: 12.5px;
    color: var(--fg-2);
  }
  .note b {
    color: var(--fg);
    font-weight: 600;
  }
  .box {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    width: 100%;
  }
  .omni {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-box);
  }
  .omni:focus-within {
    border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .omni :global(.lead) {
    flex: none;
    color: var(--muted);
    margin-left: 8px;
  }
  input {
    flex: 1;
    min-width: 0;
    height: 44px;
    border: 0;
    background: transparent;
    color: var(--fg);
    outline: none;
  }
  input::placeholder {
    color: var(--muted);
  }
  .go {
    flex: none;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 0;
    border-radius: 14px;
    background: var(--primary);
    color: var(--on-primary);
  }
  .go:disabled {
    opacity: 0.6;
  }
  .error {
    margin: 0;
    text-align: center;
    font-size: 12.5px;
    color: var(--err);
  }
  .hint {
    margin: 0;
    text-align: center;
    font-size: 12px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--mono);
    color: var(--fg-2);
  }
  .linkish {
    padding: 0;
    border: 0;
    background: none;
    color: var(--fg-2);
    font-size: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
</style>
