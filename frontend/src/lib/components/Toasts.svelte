<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Info from '@lucide/svelte/icons/info';
  import { toasts } from '$lib/state/toasts.svelte';
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each toasts.list as t (t.id)}
    <div class="toast {t.kind}" class:out={t.leaving}>
      {#if t.kind === 'err'}<CircleAlert size={15} aria-hidden="true" />{:else if t.kind === 'ok'}<Check size={15} aria-hidden="true" />{:else}<Info size={15} aria-hidden="true" />{/if}
      <span>{t.msg}</span>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    top: calc(12px + env(safe-area-inset-top, 0px));
    left: 50%;
    transform: translateX(-50%);
    z-index: 60;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: max-content;
    max-width: calc(100% - 32px);
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 14px;
    border-radius: 14px;
    background: var(--surface-2);
    border: 1px solid var(--border-strong);
    box-shadow: var(--shadow);
    font-size: 12.5px;
    color: var(--fg);
    animation: drop var(--med) ease;
    transition:
      opacity var(--med),
      transform var(--med);
  }
  .toast :global(svg) {
    flex: none;
  }
  .ok :global(svg) {
    color: var(--ok);
  }
  .err :global(svg) {
    color: var(--err);
  }
  .info :global(svg) {
    color: var(--accent);
  }
  .out {
    opacity: 0;
    transform: translateY(-6px);
  }
</style>
