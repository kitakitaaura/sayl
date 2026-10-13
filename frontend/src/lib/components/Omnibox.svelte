<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Clipboard from '@lucide/svelte/icons/clipboard';
  import Link from '@lucide/svelte/icons/link';
  import X from '@lucide/svelte/icons/x';
  import { onMount } from 'svelte';
  import { app } from '$lib/state/app.svelte';
  import { toasts } from '$lib/state/toasts.svelte';

  let value = $state('');
  let input: HTMLInputElement;
  let narrow = $state(false);

  onMount(() => {
    const mq = matchMedia('(max-width: 480px)');
    narrow = mq.matches;
    const on = () => (narrow = mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });

  async function paste() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        toasts.push('your clipboard is empty', 'info');
        return;
      }
      value = text;
      input.focus();
    } catch {
      toasts.push('your browser blocked clipboard access. paste with ctrl+v or ⌘v.', 'info');
      input.focus();
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!value.trim() || app.busy) return;
    if (await app.addSource(value)) value = '';
  }
</script>

<form class="omni" aria-label="add a torrent" onsubmit={submit}>
  <Link class="lead" size={18} aria-hidden="true" />
  <label class="sr" for="source">magnet link or .torrent url</label>
  <input
    bind:this={input}
    bind:value
    id="source"
    type="text"
    inputmode="url"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    placeholder={narrow ? 'magnet link or .torrent url' : 'paste a magnet link or .torrent url'}
  />
  {#if value}
    <button type="button" class="icon-btn bare" aria-label="clear" onclick={() => ((value = ''), input.focus())}><X size={16} aria-hidden="true" /></button>
  {/if}
  <button type="button" class="pill-btn" aria-label="paste" onclick={paste}><Clipboard size={15} aria-hidden="true" /><span>paste</span></button>
  <button type="submit" class="go" aria-label="add torrent" disabled={!value.trim() || app.busy}>
    {#if app.busy}<span class="spin" aria-hidden="true"></span>{:else}<ArrowRight size={18} aria-hidden="true" />{/if}
  </button>
</form>

<style>
  .omni {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-box);
    transition:
      border-color var(--fast),
      box-shadow var(--fast);
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
    font-size: 14px;
    outline: none;
    text-overflow: ellipsis;
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
    opacity: 0.3;
    cursor: default;
  }
  .pill-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 11px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--fg-2);
    font-size: 12px;
  }
  .pill-btn:hover {
    color: var(--fg);
    border-color: var(--border-strong);
  }
  .spin {
    width: 18px;
    height: 18px;
    border: 2px solid color-mix(in srgb, var(--on-primary) 30%, transparent);
    border-top-color: var(--on-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @media (max-width: 420px) {
    .pill-btn span {
      display: none;
    }
    .pill-btn {
      width: 32px;
      padding: 0;
      justify-content: center;
    }
  }
</style>
