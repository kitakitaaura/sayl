<script lang="ts">
  import '@fontsource/ibm-plex-mono/latin-400.css';
  import '@fontsource/ibm-plex-mono/latin-500.css';
  import '@fontsource/ibm-plex-mono/latin-600.css';
  import '@fontsource/ibm-plex-mono/latin-ext-400.css';
  import '@fontsource/ibm-plex-mono/latin-ext-500.css';
  import '@fontsource/ibm-plex-mono/latin-ext-600.css';
  import '@fontsource/inter/latin-400.css';
  import '@fontsource/inter/latin-500.css';
  import '@fontsource/inter/latin-600.css';
  import '@fontsource/inter/latin-ext-400.css';
  import '@fontsource/inter/latin-ext-500.css';
  import '@fontsource/inter/latin-ext-600.css';
  import '$lib/styles/global.css';
  import { onMount, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
  import DownloadDialog from '$lib/components/DownloadDialog.svelte';
  import DropOverlay from '$lib/components/DropOverlay.svelte';
  import FileDialog from '$lib/components/FileDialog.svelte';
  import Nav from '$lib/components/Nav.svelte';
  import RemoveDialog from '$lib/components/RemoveDialog.svelte';
  import Toasts from '$lib/components/Toasts.svelte';
  import { APP_NAME, DESCRIPTION, SITE_URL } from '$lib/config';
  import { app } from '$lib/state/app.svelte';
  import { settings } from '$lib/state/settings.svelte';
  import { ui } from '$lib/state/ui.svelte';

  let { children }: { children: Snippet } = $props();

  onMount(() => {
    settings.apply();
    void app.init();
  });

  const close = () => ui.close();
</script>

<svelte:head>
  <meta name="description" content={DESCRIPTION} />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content={APP_NAME} />
  <meta property="og:title" content={APP_NAME} />
  <meta property="og:description" content={DESCRIPTION} />
  <meta property="og:url" content={SITE_URL + page.url.pathname} />
  <meta property="og:image" content="{SITE_URL}/og.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="canonical" href={SITE_URL + page.url.pathname} />
</svelte:head>

<a class="skip" href="#main">skip to content</a>
<div class="app" id="app-shell">
  <Nav />
  <main id="main" tabindex="-1">{@render children()}</main>
</div>
<Toasts />
<DropOverlay />

{#key ui.dialog}
  {#if ui.dialog?.kind === 'files'}
    <FileDialog hash={ui.dialog.hash} intent={ui.dialog.intent} onclose={close} />
  {:else if ui.dialog?.kind === 'download'}
    <DownloadDialog hash={ui.dialog.hash} onclose={close} />
  {:else if ui.dialog?.kind === 'remove'}
    <RemoveDialog hash={ui.dialog.hash} onclose={close} />
  {:else if ui.dialog?.kind === 'confirm'}
    <ConfirmDialog title={ui.dialog.title} text={ui.dialog.text} label={ui.dialog.label} run={ui.dialog.run} onclose={close} />
  {/if}
{/key}

<style>
  .app {
    display: flex;
    height: 100%;
  }
  main {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    outline: none;
  }
  .skip {
    position: fixed;
    top: 8px;
    left: 8px;
    z-index: 80;
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--primary);
    color: var(--on-primary);
    text-decoration: none;
    transform: translateY(-200%);
  }
  .skip:focus {
    transform: none;
  }
  @media (max-width: 720px) {
    .app {
      flex-direction: column;
    }
    main {
      padding-bottom: calc(72px + env(safe-area-inset-bottom, 0px));
    }
  }
</style>
