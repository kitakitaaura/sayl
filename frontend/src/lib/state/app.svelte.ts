/**
 * The live app state: session, limits and the user's torrents, kept current
 * over server-sent events.
 */
import { browser } from '$app/environment';
import { api, ApiError, EVENTS_URL, type Limits, type TorrentView } from '$lib/api';
import { APP_NAME } from '$lib/config';
import { settings } from './settings.svelte';
import { toasts } from './toasts.svelte';
import { ui, type Intent } from './ui.svelte';

const HIDDEN_KEY = 'sayl.hidden';

export const errorMessage = (err: unknown) =>
  err instanceof ApiError ? err.message : 'something went wrong. try again.';

class App {
  /** 'loading' until the session and first list arrive; 'gate' while an access code or captcha is needed */
  status = $state<'loading' | 'gate' | 'ready' | 'offline' | 'banned'>('loading');
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
    await this.connect();
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
    else {
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
        const { files } = await api.files(hash);
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
      this.afterAdd((await api.add(s)).torrent);
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
      this.afterAdd((await api.upload(file)).torrent);
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
    } finally {
      this.busy = false;
    }
  }

  async select(hash: string, files: number[], intent: Intent): Promise<boolean> {
    try {
      const r = await api.select(hash, { files, ...intent, ratioLimit: settings.prefs.ratio });
      this.upsert(r.torrent);
      return true;
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
      return false;
    }
  }

  async act(hash: string, action: 'pause' | 'resume' | 'recheck' | 'stop-seeding'): Promise<void> {
    try {
      this.upsert((await api.action(hash, action)).torrent);
      if (action === 'recheck') toasts.push('checking pieces', 'info');
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
    }
  }

  async remove(hash: string): Promise<void> {
    const name = this.find(hash)?.name ?? 'torrent';
    try {
      await api.remove(hash);
      this.torrents = this.torrents.filter((t) => t.hash !== hash);
      this.pending.delete(hash);
      toasts.push(`deleted ${name}`, 'ok');
    } catch (err) {
      toasts.push(errorMessage(err), 'err');
    }
  }

  async removeAll(): Promise<void> {
    try {
      const { removed } = await api.removeAll();
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
    if (!settings.prefs.autoClear) return;
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
