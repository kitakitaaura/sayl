/** The visitor's relay: the Cloudflare Worker that carries their BitTorrent connections. Kept in this browser. */
import { browser } from '$app/environment';
import type { Relay } from '$bt';

const KEY = 'sayl.relay';
/** set in sessionStorage across a reload made to check a new relay */
const CHECK_KEY = 'sayl.relay-check';

function load(): { url: string; token: string } {
  if (!browser) return { url: '', token: '' };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { url?: unknown; token?: unknown };
    return { url: typeof raw.url === 'string' ? raw.url : '', token: typeof raw.token === 'string' ? raw.token : '' };
  } catch {
    return { url: '', token: '' };
  }
}

/** Tidies a relay address; returns null if it isn't one. */
export function normalizeRelayUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim().includes('://') ? input.trim() : `https://${input.trim()}`);
  } catch {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
  return u.origin;
}

class RelayConfig {
  url = $state(load().url);
  token = $state(load().token);
  /** whether this site can install a relay for the visitor (the website's Worker has an OAuth client); null until known */
  available = $state<boolean | null>(null);
  /** a relay that was just installed and isn't answering yet */
  waiting = $state(false);
  /** what went wrong with automatic setup, to show on the setup screen */
  error = $state('');

  get ready(): boolean {
    return !!this.url;
  }

  relay(): Relay | null {
    return this.url ? { url: this.url, token: this.token || undefined } : null;
  }

  async checkAvailable(): Promise<void> {
    if (this.available !== null) return;
    try {
      const res = await fetch('/api/relay/available', { cache: 'no-store' });
      const body = (await res.json()) as { available?: unknown };
      this.available = res.ok && body.available === true;
    } catch {
      this.available = false; // a static host without the Worker, or the server version
    }
  }

  /** Starts automatic setup: off to Cloudflare to approve, then back here. */
  connect(): void {
    location.href = '/api/relay/connect';
  }

  /**
   * Picks up the result of automatic setup from the address bar (#relay-url=…&relay-token=…
   * or #relay-error=…) and removes it. Returns true when a relay was handed over.
   */
  takeFromLocation(): boolean {
    if (!location.hash.includes('relay-')) return false;
    const params = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    const err = params.get('relay-error');
    if (err) {
      this.error = err;
      return false;
    }
    const url = normalizeRelayUrl(params.get('relay-url') ?? '');
    const token = params.get('relay-token') ?? '';
    if (!url || !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url)) {
      this.error = 'the relay setup came back incomplete. try again.';
      return false;
    }
    this.save(url, token);
    this.error = '';
    return true;
  }

  /**
   * Waits for a newly installed relay to answer: a new workers.dev address can take a few minutes.
   * Mostly asks the website to check from Cloudflare's side, because a browser that tries an address
   * before it's live can keep failing on it until the page is reloaded.
   *   'up'       this page reaches the relay
   *   'reload'   Cloudflare reaches it but this page still can't; a fresh page load fixes that
   *   'timeout'  nothing after timeoutMs
   * With 'reload', `waiting` stays on: the caller reloads the page.
   */
  async waitUntilUp({ timeoutMs = 10 * 60_000, mayReload = true } = {}): Promise<'up' | 'reload' | 'timeout'> {
    this.waiting = true;
    const start = Date.now();
    let upForCloudflare = 0;
    try {
      for (let round = 0; Date.now() - start < timeoutMs; round++) {
        const server = await this.checkFromServer();
        // without the website's check (or if it can't see the relay), still try now and then
        const anyway = server === null || (Date.now() - start > 45_000 && round % 3 === 0);
        if (server === true || anyway) {
          if (await this.answers()) return 'up';
          // a few tries first: the address may need a moment more to reach this browser
          if (server === true && ++upForCloudflare >= 3 && mayReload) {
            upForCloudflare = -1;
            return 'reload';
          }
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
      return 'timeout';
    } finally {
      if (upForCloudflare !== -1) this.waiting = false;
    }
  }

  /** The website's view of the relay: true or false, or null when the site can't check. */
  private async checkFromServer(): Promise<boolean | null> {
    try {
      const res = await fetch(`/api/relay/check?url=${encodeURIComponent(this.url)}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { up?: unknown };
      return typeof body.up === 'boolean' ? body.up : null;
    } catch {
      return null;
    }
  }

  /** Whether this page reaches the relay itself. */
  private async answers(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/health?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Reloads the page and checks the new relay again once it's back (without reloading a second time). */
  reloadAndCheck(): void {
    try {
      sessionStorage.setItem(CHECK_KEY, '1');
    } catch {
      // without it the page just starts with the relay as it is
    }
    location.reload();
  }

  /** Whether the page was reloaded to check a new relay. Clears the mark. */
  takeReloadMark(): boolean {
    try {
      const marked = sessionStorage.getItem(CHECK_KEY) === '1';
      sessionStorage.removeItem(CHECK_KEY);
      return marked && !!this.url;
    } catch {
      return false;
    }
  }

  save(url: string, token: string): void {
    this.url = url;
    this.token = token;
    try {
      localStorage.setItem(KEY, JSON.stringify({ url, token }));
    } catch {
      // storage blocked: it still works until the tab closes
    }
  }

  /**
   * Checks a relay before saving it. Returns null when it works, otherwise what's wrong.
   * `dht` says whether the relay can also hand out TURN logins for the DHT.
   */
  async test(url: string, token: string): Promise<{ error: string | null; dht: boolean }> {
    try {
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
      if (!health.ok) return { error: `that address answered ${health.status}. is it a relay?`, dht: false };
    } catch {
      return { error: "couldn't reach that address. check it and try again.", dht: false };
    }
    const q = token ? `?token=${encodeURIComponent(token)}` : '';
    try {
      const turn = await fetch(`${url}/turn-credentials${q}`, { signal: AbortSignal.timeout(8000) });
      if (turn.status === 403) return { error: 'the relay refused that token.', dht: false };
      const body = (await turn.json().catch(() => ({}))) as { servers?: unknown[] };
      return { error: null, dht: turn.ok && Array.isArray(body.servers) && body.servers.length > 0 };
    } catch {
      return { error: null, dht: false };
    }
  }
}

export const relayConfig = new RelayConfig();
