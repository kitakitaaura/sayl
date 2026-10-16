<script lang="ts">
  import { ABUSE_EMAIL, APP_NAME, APP_NAME_ARABIC, BROWSER_ENGINE } from '$lib/config';
  const name = APP_NAME.toLowerCase();
</script>

<svelte:head>
  <title>about · {APP_NAME}</title>
</svelte:head>

<div class="page top">
  <article class="col prose">
    <h1>about</h1>
    {#if BROWSER_ENGINE}
      <p>
        {name} downloads torrents right in your browser. you don't install anything, there's no server holding your files, and it's free for
        everyone.
      </p>
    {:else}
      <p>
        {name} downloads torrents for you on its own server, then hands you the files over normal https. you don't install anything, and other peers
        see the server, not you.
      </p>
    {/if}
    <p><span class="arabic big" lang="ar" dir="rtl">{APP_NAME_ARABIC}</span> ({name}) is arabic for a torrent, or a flash flood.</p>

    <h2>how it works</h2>
    {#if BROWSER_ENGINE}
      <ol>
        <li>paste a magnet link, or drop a .torrent file.</li>
        <li>pick the files you want.</li>
        <li>your browser downloads them from other peers. browsers can't make those connections themselves, so your <b>relay</b>, a small free program on your own cloudflare account, passes them along.</li>
        <li>the files sit in your browser's private storage. save them wherever you like.</li>
        <li>remove a torrent to free the space. closing the tab pauses downloads; they pick up again next time.</li>
      </ol>
    {:else}
      <ol>
        <li>paste a magnet link, or drop a .torrent file.</li>
        <li>pick the files you want.</li>
        <li>{name} downloads them on the server.</li>
        <li>download them in your browser, one by one or as a zip.</li>
        <li>files delete themselves 3 to 24 hours after finishing, depending on size.</li>
      </ol>
    {/if}

    <h2>privacy</h2>
    {#if BROWSER_ENGINE}
      <p>
        there are no accounts. your torrents, your files and your settings stay in this browser. peers see your relay's cloudflare address, not
        yours. finding peers for a torrent asks public trackers, and when nothing else works, the dht through a turn server (your relay's own, or one {name}
        provides); those see the torrent's info hash, as with any bittorrent client.
      </p>
    {:else}
      <p>
        there are no accounts. your browser gets an anonymous session cookie, and your torrents are tied to it. settings like the theme stay in your
        browser. clearing your cookies or resetting your session means you can't reach your old torrents anymore.
      </p>
      <p>
        while a torrent is on the server, {name} keeps the ip address that added it, to enforce limits and handle abuse reports. it's deleted along
        with the torrent.
      </p>
    {/if}

    <h2>abuse</h2>
    {#if BROWSER_ENGINE}
      <p>{name} doesn't store or transfer files; visitors' browsers and relays do. to report misuse of the website, email <span class="mono">{ABUSE_EMAIL}</span>.</p>
    {:else}
      <p>report content to <span class="mono">{ABUSE_EMAIL}</span>. we remove it and block it from being added again.</p>
    {/if}

    <h2>source</h2>
    <p>{name} is open source under the mit license.</p>
  </article>
</div>

<style>
  .big {
    font-size: 18px;
    color: var(--fg);
  }
</style>
