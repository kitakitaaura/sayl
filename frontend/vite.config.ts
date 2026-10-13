import { readFileSync } from 'node:fs';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The name comes from /brand.json; APP_NAME (set in Cloudflare Pages) overrides it.
const brand = JSON.parse(readFileSync(new URL('../brand.json', import.meta.url), 'utf8')) as { name: string; arabic: string; abuseEmail: string };
const env = (key: string) => process.env[key]?.trim() ?? '';

export default defineConfig({
  plugins: [sveltekit()],
  define: {
    __APP_NAME__: JSON.stringify(env('APP_NAME') || brand.name),
    __APP_NAME_ARABIC__: JSON.stringify(brand.arabic),
    __API_URL__: JSON.stringify(env('API_URL') || 'http://localhost:8080'),
    __SITE_URL__: JSON.stringify(env('SITE_URL') || 'https://sayl.kitaaura.com'),
    __ABUSE_EMAIL__: JSON.stringify(env('ABUSE_EMAIL') || brand.abuseEmail),
    __TURNSTILE_SITE_KEY__: JSON.stringify(env('TURNSTILE_SITE_KEY')),
  },
});
