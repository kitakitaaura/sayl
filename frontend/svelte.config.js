import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const apiOrigin = new URL(process.env.API_URL?.trim() || 'http://localhost:8080').origin;
const turnstile = 'https://challenges.cloudflare.com';

/** Every page is prerendered to static HTML for Cloudflare Pages. */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // 404.html is served by Pages for unknown paths and renders the error page
    adapter: adapter({ pages: 'build', assets: 'build', fallback: '404.html', strict: true }),
    // SvelteKit hashes its own inline scripts into this policy (a <meta> tag on each page)
    csp: {
      mode: 'hash',
      directives: {
        'default-src': ['self'],
        'script-src': ['self', turnstile],
        'style-src': ['self', 'unsafe-inline'],
        'img-src': ['self', 'data:'],
        'font-src': ['self'],
        'connect-src': ['self', apiOrigin],
        'frame-src': [turnstile],
        'base-uri': ['self'],
        'form-action': ['self'],
        'object-src': ['none'],
      },
    },
  },
};
