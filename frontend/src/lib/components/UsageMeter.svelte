<script lang="ts">
  /** Today's relay use from this browser, against Cloudflare's free daily allowance. */
  import { FREE, usage } from '$lib/browser/usage.svelte';
  import { fmtDur } from '$lib/format';

  let { warnOnly = false }: { warnOnly?: boolean } = $props();

  const rows = $derived([
    { label: 'requests', used: usage.today.workerRequests, of: FREE.workerRequests, fmt: (n: number) => n.toLocaleString('en') },
    { label: 'durable object requests', used: usage.today.doRequests, of: FREE.doRequests, fmt: (n: number) => n.toLocaleString('en') },
    { label: 'durable object time', used: usage.today.doSeconds, of: FREE.doSeconds, fmt: (n: number) => `${(n / 3600).toFixed(1)} h` },
  ]);
  const pct = (used: number, of: number) => Math.min(100, Math.round((used / of) * 100));
</script>

{#if warnOnly}
  {#if usage.highest >= 0.8}
    <div class="warn" role="status">
      this browser has used about {pct(usage.highest, 1)}% of your relay's free daily allowance on cloudflare. past it, the relay stops
      working until it resets at midnight utc (in {fmtDur(usage.resetsIn)}). seeding for hours uses the most.
    </div>
  {/if}
{:else}
  <div class="meter">
    {#each rows as r (r.label)}
      <div class="m">
        <div class="top"><span>{r.label}</span><span class="tabular">{r.fmt(r.used)} of {r.fmt(r.of)}</span></div>
        <div class="bar" role="meter" aria-label="relay {r.label} today" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct(r.used, r.of)}>
          <div class="fill" class:hot={r.used / r.of >= 0.8} style="width: {pct(r.used, r.of)}%"></div>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .meter {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;
  }
  .top {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 12px;
    color: var(--fg-2);
  }
  .bar {
    height: 6px;
    margin-top: 4px;
    border-radius: 999px;
    background: var(--border);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--accent);
  }
  .fill.hot {
    background: var(--warn);
  }
  .warn {
    padding: 10px 14px;
    border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border));
    border-radius: var(--r-box);
    font-size: 12.5px;
    color: var(--fg-2);
  }
</style>
