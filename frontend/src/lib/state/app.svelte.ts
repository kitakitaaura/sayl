/**
 * The live app state: session, limits and the user's torrents.
 *
 * With the server engine they come from the API, kept current over
 * server-sent events. With the browser engine they run in this tab
 * (see $lib/browser/engine).
 */
import { browser, dev } from '$app/environment';
import { api, ApiError, EVENTS_URL, type FileView, type Limits, type Links, type TorrentView } from '$lib/api';
import { BrowserEngine, EngineError, type AutoSelect, type ShareFile } from '$lib/browser/engine';
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
    seed: settings.prefs.seedDefault,
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
      void this.keepAwake();
    });
    this.startPlayback();
    this.applySpeedLimits();
    // a wake lock ends when the page is hidden; take it again when it's back
    document.addEventListener('visibilitychange', () => void this.keepAwake());
    await this.engine.load();
    const installed = relayConfig.takeFromLocation();
    const reloaded = !installed && relayConfig.takeReloadMark();
    this.status = relayConfig.ready && !installed && !reloaded ? 'ready' : 'setup';
    if (installed || reloaded) void this.waitForNewRelay(!reloaded);
    else if (relayConfig.ready) void relayConfig.checkVersion();
    window.addEventListener('beforeunload', (e) => {
      // closing the tab stops the downloads; they pick up again on the next visit
      if (this.engine?.busy) e.preventDefault();
    });
    // progress is saved every few seconds; save the last bit too
    window.addEventListener('pagehide', () => this.engine?.flush());
  }

  /** Applies the speed limits from settings (MB/s) to every torrent. */
  applySpeedLimits(): void {
    this.engine?.setSpeedLimits(settings.prefs.downLimit * 1e6, settings.prefs.upLimit * 1e6);
  }

  private wakeLock: WakeLockSentinel | null = null;
  private wakeLockPending = false;

  /**
   * Keeps the screen on while something downloads, if that's turned on: phones pause a page whose screen
   * is off or that's in the background, and its downloads with it.
   */
  async keepAwake(): Promise<void> {
    const want = settings.prefs.keepAwake && !!this.engine?.busy && document.visibilityState === 'visible';
    if (!want) {
      const lock = this.wakeLock;
      this.wakeLock = null;
      await lock?.release().catch(() => {});
      return;
    }
    if ((this.wakeLock && !this.wakeLock.released) || this.wakeLockPending || !('wakeLock' in navigator)) return;
    this.wakeLockPending = true;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      // refused (battery saver, or not allowed here): downloads carry on as before
    } finally {
      this.wakeLockPending = false;
    }
  }

  /**
   * Playing while downloading: the service worker answers the player's requests for /stream/… by asking
   * this page for the bytes, which the engine reads from storage once those pieces are in.
   */
  private startPlayback(): void {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/service-worker.js', { type: dev ? 'module' : 'classic' }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { type?: string; hash: string; index: number; offset: number; length: number };
      const port = e.ports[0];
      if (d?.type !== 'sayl-read' || !port || !this.engine) return;
      this.engine.readRange(d.hash, d.index, d.offset, d.length).then(
        (r) => port.postMessage({ ok: true, total: r.total, bytes: r.bytes }, [r.bytes.buffer]),
        (err) => port.postMessage({ ok: false, error: errorMessage(err) }),
      );
    });
    navigator.serviceWorker.startMessages();
  }

  /** A relay was just installed for the visitor: wait until it answers, then get going. */
  private async waitForNewRelay(mayReload: boolean): Promise<void> {
    const result = await relayConfig.waitUntilUp({ mayReload });
    if (result === 'reload') {
      relayConfig.reloadAndCheck();
    } else if (result === 'up') {
      toasts.push('your relay is ready', 'ok');
      this.relaySaved();
      // an updated relay can answer from its old version for a moment: check again until it's current
      for (let i = 0; i < 12; i++) {
        await relayConfig.checkVersion();
        if (!relayConfig.outdated) break;
        await new Promise((r) => setTimeout(r, 5000));
      }
    } else {
      relayConfig.error = "your relay was installed but isn't answering yet. new workers.dev addresses can take a while; reload this page in a few minutes.";
    }
  }

  /** Connection settings changed (browser engine): running torrents start again with them. */
  connectionsChanged(): void {
    this.engine?.relayChanged();
  }

  /** The relay settings changed (browser engine). */
  relaySaved(): void {
    if (!this.engine) return;
    this.status = relayConfig.ready ? 'ready' : 'setup';
    void relayConfig.checkVersion();
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
  private autoSelect(): AutoSelect | null {
    return this.chips.select ? null : { sequential: this.chips.sequential, seed: this.chips.seed };
  }

  /** Browser engine: makes a torrent from the visitor's files and seeds it. */
  async create(files: ShareFile[], name: string, onprogress: (fraction: number) => void, signal?: AbortSignal): Promise<{ magnet: string; torrent: Uint8Array } | null> {
    if (!this.engine) return null;
    try {
      const r = await this.engine.create(files, name, onprogress, signal);
      this.upsert(r.view);
      this.unhide(r.view.hash);
      return { magnet: r.magnet, torrent: r.torrent };
    } catch (err) {
      if (!signal?.aborted) toasts.push(errorMessage(err), 'err');
      return null;
    }
  }

  /** Browser engine: a torrent's magnet link and .torrent file. */
  share(hash: string): { name: string; magnet: string; torrent: Uint8Array | null } | null {
    try {
      return this.engine?.share(hash) ?? null;
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
      return null;
    }
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
  /** Browser engine: the finished files themselves, to save as a folder or a zip. */
  async finishedFiles(hash: string): Promise<{ name: string; files: { path: string; file: File }[] }> {
    if (!this.engine) return { name: '', files: [] };
    return this.engine.finishedFiles(hash);
  }

  async links(hash: string): Promise<Links> {
    return this.engine ? this.engine.links(hash) : api.links(hash);
  }

  async select(hash: string, files: number[], intent: Intent): Promise<boolean> {
    try {
      const r = this.engine
        ? { torrent: await this.engine.select(hash, files, { sequential: intent.sequential, seed: intent.seed }) }
        : await api.select(hash, { files, ...intent, ratioLimit: settings.prefs.ratio });
      this.upsert(r.torrent);
      return true;
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
      return false;
    }
  }

  async act(hash: string, action: 'pause' | 'resume' | 'recheck' | 'seed' | 'stop-seeding'): Promise<void> {
    try {
      if (action === 'recheck') toasts.push('checking pieces', 'info');
      if (action === 'seed' && !this.engine) return; // the server version decides seeding when files are picked
      this.upsert(this.engine ? await this.engine.action(hash, action) : (await api.action(hash, action as Exclude<typeof action, 'seed'>)).torrent);
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
