import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const env = (key) => process.env[key]?.trim() ?? '';
const engine = env('ENGINE') || (env('API_URL') ? 'server' : 'browser');
const apiOrigin = new URL(env('API_URL') || 'http://localhost:8080').origin;
const turnstile = 'https://challenges.cloudflare.com';
// In the browser engine the page talks to the visitor's own relay (any address), public tracker
// lists on GitHub and DNS over HTTPS, so it may connect anywhere over https and wss.
const connect = engine === 'browser' ? ['self', 'https:', 'wss:'] : ['self', apiOrigin];

/** Every page is prerendered to static HTML for Cloudflare Pages. */
export default {
  preprocess: vitePreprocess(),
  kit: {
    alias: { $bt: '../client' },
    // the browser engine registers it itself (for playing while downloading); the server version doesn't need it
    serviceWorker: { register: false },
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
        'connect-src': connect,
        'worker-src': ['self'],
        'frame-src': [turnstile],
        'base-uri': ['self'],
        'form-action': ['self'],
        'object-src': ['none'],
      },
    },
  },
};
