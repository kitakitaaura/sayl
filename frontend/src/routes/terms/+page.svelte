<script lang="ts">
  import { ABUSE_EMAIL, APP_NAME } from '$lib/config';
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
      <li>you're responsible for what you add. don't use {name} to break the law where you live or where the server is.</li>
      <li>don't try to get around the limits, the access checks, or another person's session.</li>
    </ul>

    <h2>how files are handled</h2>
    <ul>
      <li>files are kept only for a short time: 3 to 24 hours after a torrent finishes, depending on its size. then they're deleted for good.</li>
      <li>while a torrent downloads, the server shares pieces of it with other peers, as bittorrent requires.</li>
      <li>limits apply per session and per connection, and can change.</li>
    </ul>

    <h2>abuse and takedowns</h2>
    <p>
      to report content, email <span class="mono">{ABUSE_EMAIL}</span> with the torrent's name or info hash and why it should be removed. valid
      notices are handled quickly: the torrent is deleted and blocked from being added again. people who repeatedly add infringing content may lose access.
    </p>

    <h2>no guarantees</h2>
    <p>
      {name} is a free service provided as is, without any warranty. it can be slow, lose files, or go offline at any time. don't rely on it as the
      only copy of anything.
    </p>
  </article>
</div>
