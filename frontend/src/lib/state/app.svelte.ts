/**
 * The live app state: session, limits and the user's torrents.
 *
 * With the server engine they come from the API, kept current over
 * server-sent events. With the browser engine they run in this tab
 * (see $lib/browser/engine).
 */
import { browser } from '$app/environment';
import { api, ApiError, EVENTS_URL, type FileView, type Limits, type Links, type TorrentView } from '$lib/api';
import { BrowserEngine, EngineError } from '$lib/browser/engine';
import { relayConfig } from '$lib/browser/relay.svelte';
import { storageSupported } from '$lib/browser/storage';
import { APP_NAME, BROWSER_ENGINE } from '$lib/config';
import { settings } from './settings.svelte';
import { toasts } from './toasts.svelte';
import { ui, type Intent } from './ui.svelte';

const HIDDEN_KEY = 'sayl.hidden';

export const errorMessage = (err: unknown) =>
  err instanceof ApiError || err instanceof EngineError ? err.message : 'something went wrong. try again.';

class App {
  /**
   * 'loading' until the session and first list arrive; 'gate' while an access code or captcha is needed.
   * Browser engine: 'setup' until a relay is set, 'unsupported' if this browser can't store downloads.
   */
  status = $state<'loading' | 'gate' | 'ready' | 'offline' | 'banned' | 'setup' | 'unsupported'>('loading');
  access = $state<{ code: boolean; captcha: boolean }>({ code: false, captcha: false });
  limits = $state<Limits | null>(null);
  torrents = $state<TorrentView[]>([]);
  /** torrents hidden by auto-clear */
  hidden = $state<string[]>([]);
  busy = $state(false);
  /** ticks every second so countdowns stay live */
  now = $state(Date.now());

  chips = $state({
    sequential: settings.prefs.sequentialDefault,
    // the browser engine doesn't upload yet
    seed: BROWSER_ENGINE ? false : settings.prefs.seedDefault,
    select: settings.prefs.selectFiles,
  });

  /** torrents waiting for metadata that should start with every file once it arrives */
  private pending = new Map<string, Intent>();
  private es: EventSource | null = null;
  private started = false;
  private engine: BrowserEngine | null = null;

  visible = $derived(this.torrents.filter((t) => !this.hidden.includes(t.hash)));

  async init(): Promise<void> {
    if (!browser || this.started) return;
    this.started = true;
    try {
      this.hidden = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]') as string[];
    } catch {
      this.hidden = [];
    }
    setInterval(() => (this.now = Date.now()), 1000);
    if (BROWSER_ENGINE) await this.initBrowser();
    else await this.connect();
  }

  private async initBrowser(): Promise<void> {
    if (!storageSupported()) {
      this.status = 'unsupported';
      return;
    }
    this.engine = new BrowserEngine((views) => {
      this.torrents = views;
      void this.runPending();
    });
    await this.engine.load();
    const installed = relayConfig.takeFromLocation();
    this.status = relayConfig.ready && !installed ? 'ready' : 'setup';
    if (installed) void this.waitForNewRelay();
    window.addEventListener('beforeunload', (e) => {
      // closing the tab stops the downloads; they pick up again on the next visit
      if (this.engine?.busy) e.preventDefault();
    });
    // progress is saved every few seconds; save the last bit too
    window.addEventListener('pagehide', () => this.engine?.flush());
  }

  /** A relay was just installed for the visitor: wait until it answers, then get going. */
  private async waitForNewRelay(): Promise<void> {
    const up = await relayConfig.waitUntilUp();
    if (up) {
      toasts.push('your relay is ready', 'ok');
      this.relaySaved();
    } else {
      relayConfig.error = "your relay was installed but isn't answering yet. new workers.dev addresses can take a while; reload this page in a few minutes.";
    }
  }

  /** The relay settings changed (browser engine). */
  relaySaved(): void {
    if (!this.engine) return;
    this.status = relayConfig.ready ? 'ready' : 'setup';
    this.engine.relayChanged();
  }

  private async connect(): Promise<void> {
    try {
      const s = await api.session();
      this.limits = s.limits;
      this.access = s.access;
      if (!s.session) {
        if (s.access.code || s.access.captcha) {
          this.status = 'gate';
          return;
        }
        await api.startSession();
      }
      await this.load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'banned') {
        this.status = 'banned';
        return;
      }
      this.status = 'offline';
      setTimeout(() => void this.connect(), 5000);
    }
  }

  private async load(): Promise<void> {
    this.torrents = (await api.torrents()).torrents;
    this.status = 'ready';
    this.listen();
  }

  /** Starts a session from the gate. Returns an error message, or null on success. */
  async enter(accessCode: string, captchaToken: string): Promise<string | null> {
    try {
      await api.startSession({ accessCode: accessCode || undefined, captchaToken: captchaToken || undefined });
      await this.load();
      toasts.push("you're in", 'ok');
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  }

  private listen(): void {
    this.es?.close();
    const es = new EventSource(EVENTS_URL, { withCredentials: true });
    this.es = es;
    es.addEventListener('torrents', (e) => {
      this.torrents = JSON.parse((e as MessageEvent<string>).data) as TorrentView[];
      this.status = 'ready';
      void this.runPending();
    });
    es.onerror = () => {
      // the browser retries on its own; a closed stream means the session is gone
      if (es.readyState === EventSource.CLOSED) {
        this.status = 'offline';
        setTimeout(() => void this.connect(), 3000);
      }
    };
  }

  find(hash: string): TorrentView | undefined {
    return this.torrents.find((t) => t.hash === hash);
  }

  private upsert(t: TorrentView): void {
    const i = this.torrents.findIndex((x) => x.hash === t.hash);
    if (i === -1) this.torrents = [t, ...this.torrents];
    else this.torrents[i] = t;
  }

  private intent(): Intent {
    return { seed: this.chips.seed, sequential: this.chips.sequential };
  }

  private afterAdd(t: TorrentView): void {
    this.upsert(t);
    this.unhide(t.hash);
    toasts.push(`added ${t.name}`, 'ok');
    if (t.state !== 'metadata' && t.state !== 'selecting') return;
    if (this.chips.select) ui.open({ kind: 'files', hash: t.hash, intent: this.intent() });
    else if (this.engine) {
      // the engine starts every file itself once the metadata arrives
    } else {
      this.pending.set(t.hash, this.intent());
      void this.runPending();
    }
  }

  /** Starts torrents added with "select files" off as soon as their file list is known. */
  private async runPending(): Promise<void> {
    for (const [hash, intent] of this.pending) {
      const t = this.find(hash);
      if (!t) {
        this.pending.delete(hash);
        continue;
      }
      if (t.state !== 'selecting') continue;
      this.pending.delete(hash);
      try {
        const files = await this.files(hash);
        const r = await api.select(hash, { files: files.map((f) => f.index), ...intent, ratioLimit: settings.prefs.ratio });
        this.upsert(r.torrent);
      } catch (err) {
        toasts.push(errorMessage(err), 'err');
      }
    }
  }

  async addSource(source: string): Promise<boolean> {
    const s = source.trim();
    if (!/^magnet:\?/i.test(s) && !/^https?:\/\/\S+$/i.test(s)) {
      toasts.push("that's not a magnet link or .torrent url", 'err');
      return false;
    }
    this.busy = true;
    try {
      const known = this.engine?.has(this.hashOf(s) ?? '');
      const t = this.engine ? await this.engine.add(s, this.autoSelect()) : (await api.add(s)).torrent;
      if (known) {
        toasts.push(`${t.name} is already in your list`, 'info');
        this.unhide(t.hash);
        return true;
      }
      this.afterAdd(t);
      return true;
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
      return false;
    } finally {
      this.busy = false;
    }
  }

  async addFile(file: File): Promise<void> {
    if (!/\.torrent$/i.test(file.name)) {
      toasts.push('only .torrent files work here', 'err');
      return;
    }
    const maxKb = this.limits?.maxTorrentFileKb ?? 4096;
    if (file.size > maxKb * 1024) {
      toasts.push(`.torrent files can be at most ${maxKb} KB`, 'err');
      return;
    }
    this.busy = true;
    try {
      if (this.engine) {
        const before = new Set(this.torrents.map((t) => t.hash));
        const t = await this.engine.addTorrent(new Uint8Array(await file.arrayBuffer()), this.autoSelect());
        if (before.has(t.hash)) toasts.push(`${t.name} is already in your list`, 'info');
        else this.afterAdd(t);
        return;
      }
      this.afterAdd((await api.upload(file)).torrent);
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
    } finally {
      this.busy = false;
    }
  }

  /** For the browser engine: start every file once the metadata is in, unless the user picks them. */
  private autoSelect(): { sequential: boolean } | null {
    return this.chips.select ? null : { sequential: this.chips.sequential };
  }

  private hashOf(source: string): string | null {
    const m = /xt=urn:btih:([0-9a-f]{40})/i.exec(source);
    return m ? m[1].toLowerCase() : null;
  }

  /** The torrent's file list. */
  async files(hash: string): Promise<FileView[]> {
    return this.engine ? this.engine.files(hash) : (await api.files(hash)).files;
  }

  /** Links to save the finished files. */
  async links(hash: string): Promise<Links> {
    return this.engine ? this.engine.links(hash) : api.links(hash);
  }

  async select(hash: string, files: number[], intent: Intent): Promise<boolean> {
    try {
      const r = this.engine
        ? { torrent: await this.engine.select(hash, files, { sequential: intent.sequential }) }
        : await api.select(hash, { files, ...intent, ratioLimit: settings.prefs.ratio });
      this.upsert(r.torrent);
      return true;
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
      return false;
    }
  }

  async act(hash: string, action: 'pause' | 'resume' | 'recheck' | 'stop-seeding'): Promise<void> {
    try {
      if (action === 'recheck') toasts.push('checking pieces', 'info');
      this.upsert(this.engine ? await this.engine.action(hash, action) : (await api.action(hash, action)).torrent);
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
    }
  }

  async remove(hash: string): Promise<void> {
    const name = this.find(hash)?.name ?? 'torrent';
    try {
      if (this.engine) await this.engine.remove(hash);
      else await api.remove(hash);
      this.torrents = this.torrents.filter((t) => t.hash !== hash);
      this.pending.delete(hash);
      toasts.push(`deleted ${name}`, 'ok');
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
    }
  }

  async removeAll(): Promise<void> {
    try {
      const { removed } = this.engine ? { removed: await this.engine.removeAll() } : await api.removeAll();
      this.torrents = [];
      this.pending.clear();
      toasts.push(removed ? `deleted ${removed} torrent${removed === 1 ? '' : 's'}` : 'nothing to clear', 'ok');
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
    }
  }

  async resetSession(): Promise<void> {
    try {
      await api.endSession();
      this.es?.close();
      this.torrents = [];
      this.pending.clear();
      this.setHidden([]);
      await this.connect();
      toasts.push(this.status === 'gate' ? 'session ended' : 'started a new session', 'ok');
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
    }
  }

  /** Called after the user starts a download; with auto-clear on, the torrent leaves the list. */
  downloaded(hash: string): void {
    // the browser engine keeps files in browser storage, so hiding a torrent would hide space it still uses
    if (this.engine || !settings.prefs.autoClear) return;
    if (!this.hidden.includes(hash)) this.setHidden([...this.hidden, hash]);
    toasts.push('cleared from your list. files still delete on schedule.', 'info');
  }

  private unhide(hash: string): void {
    if (this.hidden.includes(hash)) this.setHidden(this.hidden.filter((h) => h !== hash));
  }

  private setHidden(list: string[]): void {
    // forget hashes that no longer exist so the list doesn't grow forever
    const known = new Set(this.torrents.map((t) => t.hash));
    this.hidden = list.filter((h) => known.has(h) || !this.torrents.length);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(this.hidden));
    } catch {
      // storage blocked
    }
  }
}

export const app = new App();
export { APP_NAME };
