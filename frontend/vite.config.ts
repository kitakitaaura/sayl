import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// The name comes from /brand.json; APP_NAME (set in Cloudflare Pages) overrides it.
const brand = JSON.parse(readFileSync(new URL('../brand.json', import.meta.url), 'utf8')) as { name: string; arabic: string; abuseEmail: string; repo: string };
const env = (key: string) => process.env[key]?.trim() ?? '';
// Where torrents run: 'browser' (in the visitor's browser, through a relay) or 'server' (a self-hosted backend).
// Without ENGINE, a site built with API_URL talks to that server, and one without runs in the browser.
const engine = env('ENGINE') || (env('API_URL') ? 'server' : 'browser');
// The relay this site installs and expects; older relays get an "update your relay" notice.
const relaySource = readFileSync(new URL('../relay/worker/index.js', import.meta.url), 'utf8');
const relayVersion = Number(/^const RELAY_VERSION = (\d+);/m.exec(relaySource)?.[1]);
if (!relayVersion) throw new Error('relay/worker/index.js has no RELAY_VERSION');
// Which build this is, for bug reports: the commit (Workers Builds sets WORKERS_CI_COMMIT_SHA), else git, else the date.
const build = (() => {
  const sha = env('WORKERS_CI_COMMIT_SHA');
  if (sha) return sha.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
})();
if (engine !== 'server' && engine !== 'browser') throw new Error(`ENGINE must be "server" or "browser", not "${engine}"`);

export default defineConfig({
  plugins: [sveltekit()],
  // the BitTorrent client lives in ../client
  server: { fs: { allow: ['..'] } },
  define: {
    __ENGINE__: JSON.stringify(engine),
    __APP_NAME__: JSON.stringify(env('APP_NAME') || brand.name),
    __APP_NAME_ARABIC__: JSON.stringify(brand.arabic),
    __API_URL__: JSON.stringify(env('API_URL') || 'http://localhost:8080'),
    __SITE_URL__: JSON.stringify(env('SITE_URL') || 'https://sayl.kitaaura.com'),
    __ABUSE_EMAIL__: JSON.stringify(env('ABUSE_EMAIL') || brand.abuseEmail),
    __TURNSTILE_SITE_KEY__: JSON.stringify(env('TURNSTILE_SITE_KEY')),
    __RELAY_VERSION__: JSON.stringify(relayVersion),
    __BUILD__: JSON.stringify(build),
    __REPO_URL__: JSON.stringify(env('REPO_URL') || brand.repo),
  },
});
