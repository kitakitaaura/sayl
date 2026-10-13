import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** Every page is prerendered to static HTML for Cloudflare Pages. */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // 404.html is served by Pages for unknown paths and renders the error page
    adapter: adapter({ pages: 'build', assets: 'build', fallback: '404.html', strict: true }),
  },
};
