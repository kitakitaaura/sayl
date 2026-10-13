<script lang="ts">
  // Sayl's wave glyph: two stacked waves, the lower one in the accent colour.
  let { size = 32 }: { size?: number } = $props();
</script>

<svg class="glyph" width={size} height={size} viewBox="0 0 32 32" fill="none" stroke-linecap="round" aria-hidden="true">
  <path stroke="currentColor" stroke-width="2.6" d="M4 12.5q3-3.5 6 0t6 0 6 0 6 0" />
  <path style="stroke: var(--accent)" stroke-width="2.6" d="M4 19.5q3-3.5 6 0t6 0 6 0 6 0" />
</svg>

<style>
  .glyph {
    flex: none;
  }
</style>
