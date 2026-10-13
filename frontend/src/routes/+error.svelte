<script lang="ts">
  import { page } from '$app/state';
  import Wordmark from '$lib/components/Wordmark.svelte';
  import { APP_NAME } from '$lib/config';
</script>

<svelte:head>
  <title>{page.status === 404 ? 'not found' : 'error'} · {APP_NAME}</title>
</svelte:head>

<div class="page">
  <div class="col">
    <Wordmark />
    <h1 class="msg">{page.status === 404 ? "this page doesn't exist" : 'something went wrong'}</h1>
    <a class="btn" href="/">back to {APP_NAME.toLowerCase()}</a>
  </div>
</div>

<style>
  .col {
    align-items: center;
  }
  .msg {
    margin: 0;
    font-size: 14px;
    font-weight: 400;
    color: var(--muted);
  }
</style>
