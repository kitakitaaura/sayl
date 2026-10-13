<script lang="ts">
  import { page } from '$app/state';
  import Download from '@lucide/svelte/icons/download';
  import FileText from '@lucide/svelte/icons/file-text';
  import Info from '@lucide/svelte/icons/info';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import Glyph from './Glyph.svelte';

  const items = [
    { href: '/', label: 'download', icon: Download },
    { href: '/settings', label: 'settings', icon: SlidersHorizontal },
    { href: '/about', label: 'about', icon: Info },
    { href: '/terms', label: 'terms', icon: FileText },
  ];
  const current = (href: string) => (href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href));
</script>

<nav class="nav" aria-label="main">
  <a class="logo" href="/" aria-label="home"><Glyph size={30} /></a>
  {#each items as item (item.href)}
    <a class="item" href={item.href} aria-current={current(item.href) ? 'page' : undefined}>
      <item.icon size={20} aria-hidden="true" />
      <span>{item.label}</span>
    </a>
  {/each}
</nav>

<style>
  .nav {
    flex: none;
    width: var(--nav-w);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 16px 8px;
    border-right: 1px solid var(--border);
  }
  .logo {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    margin-bottom: 12px;
    color: var(--fg);
    border-radius: 12px;
  }
  .item {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 4px 8px;
    border-radius: 14px;
    color: var(--muted);
    font-size: 11px;
    text-decoration: none;
    transition:
      background-color var(--fast) ease,
      color var(--fast) ease;
  }
  .item:hover {
    color: var(--fg);
  }
  .item[aria-current='page'] {
    background: var(--surface-2);
    color: var(--fg);
  }
  @media (max-width: 720px) {
    .nav {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 40;
      width: auto;
      flex-direction: row;
      justify-content: space-around;
      gap: 0;
      padding: 6px 8px calc(6px + env(safe-area-inset-bottom, 0px));
      border-right: 0;
      border-top: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 90%, transparent);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    .logo {
      display: none;
    }
    .item {
      flex: 1;
      max-width: 96px;
    }
  }
</style>
