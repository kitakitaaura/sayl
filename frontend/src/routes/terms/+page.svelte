<script lang="ts">
  import { ABUSE_EMAIL, APP_NAME, BROWSER_ENGINE } from '$lib/config';
  const name = APP_NAME.toLowerCase();
</script>

<svelte:head>
  <title>terms · {APP_NAME}</title>
</svelte:head>

<div class="page top">
  <article class="col prose">
    <h1>terms</h1>
    <p>by using {name} you agree to these terms. they're short on purpose.</p>

    <h2>what you can use it for</h2>
    <ul>
      <li>only download content you have the right to download: things that are free to share, that you own, or that you have permission for.</li>
      {#if BROWSER_ENGINE}<li>only share (seed, or make a torrent of) content you have the right to share. sharing is off unless you turn it on.</li>{/if}
      <li>you're responsible for what you add. don't use {name} to break the law where you live{BROWSER_ENGINE ? '' : ' or where the server is'}.</li>
      {#if !BROWSER_ENGINE}<li>don't try to get around the limits, the access checks, or another person's session.</li>{/if}
    </ul>

    <h2>how files are handled</h2>
    {#if BROWSER_ENGINE}
      <ul>
        <li>torrents run in your browser, and their files stay in your browser's storage until you remove them. {name} never holds your files.</li>
        <li>your relay runs on your own cloudflare account, under cloudflare's terms. what passes through it, in both directions, is your responsibility.</li>
        <li>when you share files, {name} copies them into your browser's storage so it can keep seeding them. they stay there until you remove the torrent.</li>
      </ul>
    {:else}
      <ul>
        <li>files are kept only for a short time: 3 to 24 hours after a torrent finishes, depending on its size. then they're deleted for good.</li>
        <li>while a torrent downloads, the server shares pieces of it with other peers, as bittorrent requires.</li>
        <li>limits apply per session and per connection, and can change.</li>
      </ul>
    {/if}

    <h2>abuse and takedowns</h2>
    {#if BROWSER_ENGINE}
      <p>
        {name} doesn't store or transfer files: each visitor's own browser and relay do. if you believe the {name} website itself is being misused,
        email <span class="mono">{ABUSE_EMAIL}</span>.
      </p>
    {:else}
      <p>
        to report content, email <span class="mono">{ABUSE_EMAIL}</span> with the torrent's name or info hash and why it should be removed. valid
        notices are handled quickly: the torrent is deleted and blocked from being added again. people who repeatedly add infringing content may lose access.
      </p>
    {/if}

    <h2>no guarantees</h2>
    <p>
      {name} is a free service provided as is, without any warranty. it can be slow, lose files, or go offline at any time. don't rely on it as the
      only copy of anything.
    </p>
  </article>
</div>
