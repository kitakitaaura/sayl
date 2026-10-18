<script lang="ts">
  import { onMount } from 'svelte';
  import RelaySetup from '$lib/components/RelaySetup.svelte';
  import UsageMeter from '$lib/components/UsageMeter.svelte';
  import Segmented from '$lib/components/Segmented.svelte';
  import Switch from '$lib/components/Switch.svelte';
  import { APP_NAME, BROWSER_ENGINE } from '$lib/config';
  import { fmtBytes } from '$lib/format';
  import { reportUrl } from '$lib/browser/report';
  import { app } from '$lib/state/app.svelte';
  import { RATIO_CHOICES, settings, type Theme } from '$lib/state/settings.svelte';
  import { ui } from '$lib/state/ui.svelte';

  const p = $derived(settings.prefs);
  const limits = $derived(app.limits);
  const name = APP_NAME.toLowerCase();

  function setSeedDefault(v: boolean) {
    settings.set('seedDefault', v);
    app.chips.seed = v;
  }
  function setLimit(key: 'downLimit' | 'upLimit', value: string) {
    const n = Number(value);
    settings.set(key, Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 0);
    app.applySpeedLimits();
  }
  function setKeepAwake(v: boolean) {
    settings.set('keepAwake', v);
    void app.keepAwake();
  }
  function setWebrtc(v: boolean) {
    settings.set('webrtc', v);
    app.connectionsChanged();
  }
  function setSequentialDefault(v: boolean) {
    settings.set('sequentialDefault', v);
    app.chips.sequential = v;
  }

  // browser engine: how much of the browser's storage downloads use
  let usage = $state<{ used: number; quota: number } | null>(null);
  onMount(() => {
    if (!BROWSER_ENGINE) return;
    navigator.storage
      ?.estimate?.()
      .then((e) => (usage = e.quota ? { used: e.usage ?? 0, quota: e.quota } : null))
      .catch(() => {});
  });
</script>

<svelte:head>
  <title>settings · {APP_NAME}</title>
</svelte:head>

<div class="page top">
  <div class="col wide">
    <h1 class="ttl">settings</h1>

    <section class="section" aria-labelledby="s-app">
      <h2 id="s-app">appearance</h2>
      <div class="row">
        <div class="lbl"><b>theme</b></div>
        <Segmented
          label="theme"
          value={p.theme}
          options={[
            { value: 'auto' as Theme, label: 'auto' },
            { value: 'dark' as Theme, label: 'dark' },
            { value: 'light' as Theme, label: 'light' },
          ]}
          onchange={(v) => settings.set('theme', v)}
        />
      </div>
      <div class="row">
        <div class="lbl"><b>reduce motion</b><span>turns off animations. {name} also follows your system setting.</span></div>
        <Switch label="reduce motion" checked={p.reduceMotion} onchange={(v) => settings.set('reduceMotion', v)} />
      </div>
    </section>

    {#if BROWSER_ENGINE}
      <section class="section" aria-labelledby="s-relay">
        <h2 id="s-relay">relay</h2>
        <div class="row">
          <div class="lbl">
            <b>your relay</b><span>the cloudflare worker that connects this browser to other peers. it runs on your own free cloudflare account.</span>
          </div>
          <RelaySetup compact />
        </div>
        <div class="row col">
          <div class="lbl">
            <b>relay use today</b>
            <span>
              from this browser, estimated, against cloudflare's free daily allowance (it resets at midnight utc). other devices on the same
              relay add to it. downloads and seeding each keep a durable object busy, which counts as time.
            </span>
          </div>
          <UsageMeter />
        </div>
      </section>

      <section class="section" aria-labelledby="s-sh">
        <h2 id="s-sh">sharing</h2>
        <div class="row">
          <div class="lbl"><b>seed after by default</b><span>turns on "seed after" for every new torrent. finished torrents then keep sharing while this tab is open.</span></div>
          <Switch label="seed after by default" checked={p.seedDefault} onchange={setSeedDefault} />
        </div>
        <div class="row">
          <div class="lbl">
            <b>direct connections (webrtc)</b>
            <span>
              also trade pieces straight with other browsers: other {name} users and webtorrent apps. faster, and they can reach you when you
              seed. but those browsers and the webtorrent trackers see your ip address, not just your relay's. off by default.
            </span>
          </div>
          <Switch label="direct connections (webrtc)" checked={p.webrtc} onchange={setWebrtc} />
        </div>
        <div class="row">
          <div class="lbl"><b>ratio limit</b><span>seeding stops once a torrent has uploaded this many times its size, or when you close this tab.</span></div>
          <Segmented label="ratio limit" value={p.ratio} options={RATIO_CHOICES.map((r) => ({ value: r as number, label: r.toFixed(1) }))} onchange={(v) => settings.set('ratio', v)} />
        </div>
      </section>

      <section class="section" aria-labelledby="s-sp">
        <h2 id="s-sp">speed</h2>
        <div class="row">
          <div class="lbl"><b>download limit</b><span>for all torrents together, in MB/s. empty for no limit.</span></div>
          <input class="num" type="number" min="0" step="0.5" inputmode="decimal" placeholder="no limit" aria-label="download limit (MB/s)" value={p.downLimit || ''} onchange={(e) => setLimit('downLimit', e.currentTarget.value)} />
        </div>
        <div class="row">
          <div class="lbl"><b>upload limit</b><span>for all torrents you share, together, in MB/s. empty for no limit.</span></div>
          <input class="num" type="number" min="0" step="0.5" inputmode="decimal" placeholder="no limit" aria-label="upload limit (MB/s)" value={p.upLimit || ''} onchange={(e) => setLimit('upLimit', e.currentTarget.value)} />
        </div>
      </section>

      <section class="section" aria-labelledby="s-dv">
        <h2 id="s-dv">this device</h2>
        <div class="row">
          <div class="lbl">
            <b>keep the screen on while downloading</b>
            <span>
              phones pause a page when the screen turns off or you switch apps, and its downloads stop until you come back. this keeps the
              screen on while something downloads. on by default on phones and tablets.
            </span>
          </div>
          <Switch label="keep the screen on while downloading" checked={p.keepAwake} onchange={setKeepAwake} />
        </div>
        <div class="row">
          <div class="lbl">
            <b>same list on all your devices</b>
            <span>
              torrents you add show up on your other devices that use the same relay (set them up with the same cloudflare account), paused
              until you resume them there. removing one removes it elsewhere only where nothing of it was downloaded. the list is kept on your
              relay, in your own cloudflare account.
            </span>
          </div>
          <Switch label="same list on all your devices" checked={p.syncList} onchange={(v) => (settings.set('syncList', v), app.syncChanged())} />
        </div>
        <div class="row">
          <div class="lbl">
            <b>install {name}</b>
            <span>
              add it to your home screen or dock to open it like an app: in chrome or edge, the install icon in the address bar (on android, menu →
              add to home screen); on iphone and ipad, share → add to home screen.
            </span>
          </div>
        </div>
      </section>

      <section class="section" aria-labelledby="s-st">
        <h2 id="s-st">storage</h2>
        <div class="row">
          <div class="lbl">
            <b>browser storage</b>
            <span>
              downloads stay in this browser's private storage until you remove them.
              {#if usage}{fmtBytes(usage.used)} used, about {fmtBytes(Math.max(0, usage.quota - usage.used))} free.{/if}
            </span>
          </div>
        </div>
      </section>
    {/if}

    {#if !BROWSER_ENGINE}
    <section class="section" aria-labelledby="s-dl">
      <h2 id="s-dl">downloads</h2>
      <div class="row">
        <div class="lbl"><b>seed after by default</b><span>turns on "seed after" for every new torrent.</span></div>
        <Switch label="seed after by default" checked={p.seedDefault} onchange={setSeedDefault} />
      </div>
      <div class="row">
        <div class="lbl">
          <b>ratio limit</b><span>seeding stops at this ratio or after {limits ? limits.seedMaxMinutes / 60 : 1} hour, whichever comes first.</span>
        </div>
        <Segmented label="ratio limit" value={p.ratio} options={RATIO_CHOICES.map((r) => ({ value: r as number, label: r.toFixed(1) }))} onchange={(v) => settings.set('ratio', v)} />
      </div>
      <div class="row">
        <div class="lbl"><b>auto-clear</b><span>hides a torrent from your list once you download it. files still delete on schedule.</span></div>
        <Switch label="auto-clear" checked={p.autoClear} onchange={(v) => settings.set('autoClear', v)} />
      </div>
      {#if limits}
        <div class="row">
          <div class="lbl">
            <b>your limits</b>
            <span>{limits.maxActive} active torrents, {limits.maxStorageGb} gb stored at once, {limits.maxTorrentGb} gb per torrent.</span>
          </div>
        </div>
        <div class="row">
          <div class="lbl"><b>how long files stay</b><span>counted from when a torrent finishes, by the size of the files you picked.</span></div>
          <div class="tiers tabular">
            {#each limits.retention as t (t.maxGb)}
              <div><b>{t.hours}h</b>up to {t.maxGb} gb</div>
            {/each}
          </div>
        </div>
      {/if}
    </section>

    {/if}

    {#if BROWSER_ENGINE}
      <section class="section" aria-labelledby="s-help">
        <h2 id="s-help">help</h2>
        <div class="row">
          <div class="lbl">
            <b>report a problem</b>
            <span>opens a github issue filled in with your browser, relay version and settings (no torrent names). for one torrent, open its details (tap its name) and report from there.</span>
          </div>
          <a class="btn sm" href={reportUrl(null)} target="_blank" rel="noopener">report</a>
        </div>
      </section>
    {/if}

    <section class="section" aria-labelledby="s-pr">
      <h2 id="s-pr">privacy</h2>
      <div class="row">
        <div class="lbl"><b>clear my torrents</b><span>stops and deletes all your torrents and their files now{BROWSER_ENGINE ? ', freeing the browser storage they use' : ''}.</span></div>
        <button
          type="button"
          class="btn sm danger"
          onclick={() =>
            ui.open({
              kind: 'confirm',
              title: 'clear my torrents',
              text: 'this stops and deletes all your torrents and their files. it can’t be undone.',
              label: 'clear all',
              run: () => app.removeAll(),
            })}>clear</button
        >
      </div>
      {#if !BROWSER_ENGINE}
      <div class="row">
        <div class="lbl"><b>reset session</b><span>starts a new anonymous session. your current torrents become unreachable and delete on schedule.</span></div>
        <button
          type="button"
          class="btn sm"
          onclick={() =>
            ui.open({
              kind: 'confirm',
              title: 'reset session',
              text: 'you get a new anonymous session. your current torrents become unreachable and delete on schedule.',
              label: 'reset',
              run: () => app.resetSession(),
            })}>reset</button
        >
      </div>
      {/if}
    </section>

    <section class="section" aria-labelledby="s-adv">
      <h2 id="s-adv">advanced</h2>
      <div class="row">
        <div class="lbl"><b>sequential by default</b><span>downloads pieces in order. can be slower.</span></div>
        <Switch label="sequential by default" checked={p.sequentialDefault} onchange={setSequentialDefault} />
      </div>
      <div class="row">
        <div class="lbl"><b>show info hashes</b><span>shows each torrent’s hash on its card.</span></div>
        <Switch label="show info hashes" checked={p.showHashes} onchange={(v) => settings.set('showHashes', v)} />
      </div>
    </section>
  </div>
</div>

<style>
  .row.col {
    flex-direction: column;
    align-items: stretch;
  }
  .num {
    flex: none;
    width: 110px;
    height: 36px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--fg);
    text-align: right;
  }
  .section {
    padding: 4px 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 18px;
  }
  h2 {
    margin: 14px 0 2px;
    font-size: 13px;
    font-weight: 600;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 10px 16px;
    padding-block: 12px;
    border-top: 1px solid var(--border);
  }
  h2 + .row {
    border-top: 0;
  }
  .lbl {
    flex: 1 1 220px;
    min-width: 0;
  }
  .lbl b {
    display: block;
    font-size: 13.5px;
    font-weight: 500;
  }
  .lbl span {
    display: block;
    margin-top: 2px;
    font-size: 12px;
    color: var(--muted);
  }
  .tiers {
    width: 100%;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .tiers div {
    padding: 8px 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 12px;
    font-size: 11.5px;
    color: var(--muted);
  }
  .tiers b {
    display: block;
    font-size: 14px;
    font-weight: 600;
    color: var(--fg);
  }
  @media (max-width: 720px) {
    .tiers {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
