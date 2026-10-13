<script lang="ts">
  import { ABUSE_EMAIL, APP_NAME, APP_NAME_ARABIC } from '$lib/config';
  const name = APP_NAME.toLowerCase();
</script>

<svelte:head>
  <title>about · {APP_NAME}</title>
</svelte:head>

<div class="page top">
  <article class="col prose">
    <h1>about</h1>
    <p>
      {name} downloads torrents for you on its own server, then hands you the files over normal https. you don't install anything, and other peers
      see the server, not you.
    </p>
    <p><span class="arabic big" lang="ar" dir="rtl">{APP_NAME_ARABIC}</span> ({name}) is arabic for a torrent, or a flash flood.</p>

    <h2>how it works</h2>
    <ol>
      <li>paste a magnet link, or drop a .torrent file.</li>
      <li>pick the files you want.</li>
      <li>{name} downloads them on the server.</li>
      <li>download them in your browser, one by one or as a zip.</li>
      <li>files delete themselves 3 to 24 hours after finishing, depending on size.</li>
    </ol>

    <h2>privacy</h2>
    <p>
      there are no accounts. your browser gets an anonymous session cookie, and your torrents are tied to it. settings like the theme stay in your
      browser. clearing your cookies or resetting your session means you can't reach your old torrents anymore.
    </p>
    <p>
      while a torrent is on the server, {name} keeps the ip address that added it, to enforce limits and handle abuse reports. it's deleted along
      with the torrent.
    </p>

    <h2>abuse</h2>
    <p>report content to <span class="mono">{ABUSE_EMAIL}</span>. we remove it and block it from being added again.</p>

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
