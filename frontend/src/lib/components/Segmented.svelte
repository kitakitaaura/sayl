<script lang="ts" generics="T extends string | number">
  /** A radio group styled as segmented buttons. Arrow keys move between options. */
  let { label, options, value, onchange }: { label: string; options: { value: T; label: string }[]; value: T; onchange: (v: T) => void } = $props();

  let group: HTMLDivElement;

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length]!;
    onchange(next.value);
    queueMicrotask(() => group.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  }
</script>

<div class="seg" role="radiogroup" aria-label={label} bind:this={group} {onkeydown} tabindex="-1">
  {#each options as o (o.value)}
    <button type="button" role="radio" aria-checked={o.value === value} tabindex={o.value === value ? 0 : -1} onclick={() => onchange(o.value)}>{o.label}</button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .seg:focus {
    outline: none;
  }
  button {
    border: 0;
    border-radius: 9px;
    background: transparent;
    padding: 6px 12px;
    font-size: 12.5px;
    color: var(--fg-2);
  }
  button[aria-checked='true'] {
    background: var(--primary);
    color: var(--on-primary);
  }
</style>
