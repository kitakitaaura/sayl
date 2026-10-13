<script lang="ts">
  /**
   * A centred modal on desktop and a bottom sheet on phones. Traps focus,
   * closes on Escape or a backdrop click, makes the page behind it inert and
   * returns focus to where it was.
   */
  import X from '@lucide/svelte/icons/x';
  import { onMount, type Snippet } from 'svelte';

  let {
    title,
    subtitle = '',
    small = false,
    onclose,
    children,
    footer,
  }: {
    title: string;
    subtitle?: string;
    small?: boolean;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
  } = $props();

  let sheet: HTMLDivElement;
  const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;

  const focusables = () =>
    [...sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
      (el) => el.offsetParent !== null || el.getAttribute('type') === 'checkbox',
    );

  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    const shell = document.getElementById('app-shell');
    shell?.setAttribute('inert', '');
    (sheet.querySelector<HTMLElement>('[data-autofocus]:not([disabled])') ?? sheet.querySelector<HTMLElement>('.close'))?.focus();
    return () => {
      shell?.removeAttribute('inert');
      if (previous && document.contains(previous)) previous.focus();
    };
  });

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window {onkeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -- Escape closes it; the backdrop is a mouse convenience -->
<div class="layer" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div class="sheet" class:small bind:this={sheet} role="dialog" aria-modal="true" aria-labelledby={id}>
    <div class="grab" aria-hidden="true"></div>
    <div class="head">
      <div class="ht">
        <h2 {id}>{title}</h2>
        {#if subtitle}<p title={subtitle}>{subtitle}</p>{/if}
      </div>
      <button type="button" class="icon-btn close" aria-label="close" onclick={onclose}><X size={16} aria-hidden="true" /></button>
    </div>
    {@render children()}
    {#if footer}
      <div class="foot">{@render footer()}</div>
    {/if}
  </div>
</div>

<style>
  .layer {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 16px;
    background: var(--backdrop);
    animation: fade var(--med) ease;
  }
  .sheet {
    width: 100%;
    max-width: 460px;
    max-height: min(80dvh, 640px);
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 20px;
    box-shadow: var(--shadow);
    animation: pop var(--med) ease;
  }
  .sheet.small {
    max-width: 380px;
  }
  .grab {
    display: none;
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 16px 16px 10px;
  }
  .ht {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .ht p {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px 16px;
    border-top: 1px solid var(--border);
  }
  @media (max-width: 720px) {
    .layer {
      place-items: end stretch;
      padding: 0;
    }
    .sheet,
    .sheet.small {
      max-width: none;
      max-height: 86dvh;
      border-radius: 20px 20px 0 0;
      border-bottom: 0;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      animation: up var(--med) ease;
    }
    .grab {
      display: block;
      width: 36px;
      height: 4px;
      margin: 8px auto 0;
      border-radius: 999px;
      background: var(--border-strong);
    }
  }
</style>
