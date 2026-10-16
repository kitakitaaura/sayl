/** The visitor's relay: the Cloudflare Worker that carries their BitTorrent connections. Kept in this browser. */
import { browser } from '$app/environment';
import type { Relay } from '$bt';

const KEY = 'sayl.relay';

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

  get ready(): boolean {
    return !!this.url;
  }

  relay(): Relay | null {
    return this.url ? { url: this.url, token: this.token || undefined } : null;
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
