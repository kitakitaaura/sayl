<script lang="ts">
  // Placeholder until stage 3 builds the approved UI.
  import { APP_NAME, APP_NAME_ARABIC } from '$lib/config';
</script>

<svelte:head>
  <title>{APP_NAME}</title>
  <meta name="description" content="{APP_NAME} downloads torrents on a server and hands you the files over https." />
</svelte:head>

<main>
  <h1>{APP_NAME.toLowerCase()} <span lang="ar" dir="rtl">{APP_NAME_ARABIC}</span></h1>
  <p>coming soon</p>
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    place-content: center;
    gap: 8px;
    padding-inline: 16px;
    text-align: center;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #0b0c0d;
    color: #e9edef;
  }
  h1 {
    margin: 0;
    font-size: 30px;
  }
  span {
    font-family: system-ui, sans-serif;
    font-size: 15px;
    color: #808b91;
  }
  p {
    margin: 0;
    color: #808b91;
  }
</style>
