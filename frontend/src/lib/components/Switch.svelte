<script lang="ts">
  let { label, checked, onchange }: { label: string; checked: boolean; onchange: (v: boolean) => void } = $props();
</script>

<button type="button" class="sw" role="switch" aria-checked={checked} aria-label={label} onclick={() => onchange(!checked)}></button>

<style>
  .sw {
    flex: none;
    position: relative;
    width: 38px;
    height: 22px;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--surface-3);
  }
  .sw::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--muted);
    transition:
      transform var(--fast) ease,
      background-color var(--fast);
  }
  .sw[aria-checked='true'] {
    background: var(--accent);
    border-color: var(--accent);
  }
  .sw[aria-checked='true']::after {
    transform: translateX(16px);
    background: var(--on-accent);
  }
</style>
