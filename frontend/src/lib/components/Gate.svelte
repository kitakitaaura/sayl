<script lang="ts">
  /** Shown instead of the omnibox while a session needs the beta access code and/or the captcha. */
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Lock from '@lucide/svelte/icons/lock';
  import { onMount } from 'svelte';
  import { APP_NAME, TURNSTILE_SITE_KEY } from '$lib/config';
  import { app } from '$lib/state/app.svelte';

  interface Turnstile {
    render(el: HTMLElement, opts: Record<string, unknown>): string;
    reset(id?: string): void;
    remove(id?: string): void;
  }

  const name = APP_NAME.toLowerCase();
  const needCode = app.access.code;
  const needCaptcha = app.access.captcha;

  let code = $state('');
  let token = $state('');
  let error = $state('');
  let busy = $state(false);
  let widget = $state<HTMLDivElement>();
  let turnstile: Turnstile | undefined;
  let widgetId: string | undefined;

  function loadTurnstile(): Promise<Turnstile> {
    const w = window as unknown as { turnstile?: Turnstile };
    if (w.turnstile) return Promise.resolve(w.turnstile);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('turnstile missing')));
      s.onerror = () => reject(new Error('turnstile failed to load'));
      document.head.append(s);
    });
  }

  onMount(() => {
    if (!needCaptcha) return;
    if (!TURNSTILE_SITE_KEY) {
      error = "the captcha isn't set up on this site yet. try again later.";
      return;
    }
    let cancelled = false;
    loadTurnstile()
      .then((t) => {
        if (cancelled || !widget) return;
        turnstile = t;
        const theme = document.documentElement.dataset.theme ?? 'auto';
        widgetId = t.render(widget, {
          sitekey: TURNSTILE_SITE_KEY,
          theme,
          callback: (tk: string) => {
            token = tk;
            error = '';
            if (!needCode) void submit();
          },
          'expired-callback': () => (token = ''),
          'error-callback': () => {
            token = '';
            error = "the captcha couldn't load. check your connection and reload.";
          },
        });
      })
      .catch(() => (error = "the captcha couldn't load. check your connection and reload."));
    return () => {
      cancelled = true;
      if (widgetId) turnstile?.remove(widgetId);
    };
  });

  async function submit(e?: SubmitEvent) {
    e?.preventDefault();
    if (busy) return;
    if (needCode && !code.trim()) {
      error = 'enter your access code';
      return;
    }
    if (needCaptcha && !token) {
      error = 'complete the captcha first';
      return;
    }
    busy = true;
    error = '';
    const err = await app.enter(code.trim(), token);
    busy = false;
    if (err) {
      error = err;
      token = '';
      if (widgetId) turnstile?.reset(widgetId);
    }
  }
</script>

<p class="note">
  {needCode ? `${name} is in private beta. enter your access code to continue.` : `one quick check before you start.`}
</p>

<form class="box" onsubmit={submit} aria-label="start a session">
  {#if needCode}
    <div class="omni">
      <Lock class="lead" size={18} aria-hidden="true" />
      <label class="sr" for="code">access code</label>
      <input id="code" type="password" autocomplete="off" placeholder="access code" bind:value={code} />
      <button type="submit" class="go" aria-label="continue" disabled={busy}><ArrowRight size={18} aria-hidden="true" /></button>
    </div>
  {/if}
  {#if needCaptcha}
    <div class="captcha" bind:this={widget}></div>
  {/if}
  {#if !needCode}
    <button type="submit" class="btn primary" disabled={busy || !token}>continue</button>
  {/if}
</form>

{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if needCode}<p class="hint">no code? {name} opens to everyone soon.</p>{/if}

<style>
  .note {
    margin: 0;
    text-align: center;
    font-size: 12.5px;
    color: var(--fg-2);
  }
  .box {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
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
  .captcha {
    display: flex;
    justify-content: center;
    min-height: 65px;
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
  }
</style>
