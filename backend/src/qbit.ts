/**
 * Minimal client for the qBittorrent Web API (v2). The backend is the only
 * thing that talks to qBittorrent; its web UI is never exposed publicly.
 */

export class QbitError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'QbitError';
  }
}

export interface QbitOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** The subset of /api/v2/app/preferences that Sayl manages. */
export interface QbitPreferences {
  dht?: boolean;
  pex?: boolean;
  lsd?: boolean;
  encryption?: number;
  bittorrent_protocol?: number;
  listen_port?: number;
  random_port?: boolean;
  upnp?: boolean;
  anonymous_mode?: boolean;
  queueing_enabled?: boolean;
  max_active_torrents?: number;
  max_active_downloads?: number;
  max_active_uploads?: number;
  dl_limit?: number;
  up_limit?: number;
  save_path?: string;
  temp_path_enabled?: boolean;
  auto_tmm_enabled?: boolean;
  torrent_content_layout?: string;
  current_network_interface?: string;
  current_interface_address?: string;
  [key: string]: unknown;
}

/** One torrent from /api/v2/torrents/info (fields Sayl uses). */
export interface QbitTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
  /** bytes of the files selected for download */
  size: number;
  /** bytes of all files, -1 before metadata */
  total_size: number;
  tags: string;
  save_path: string;
  content_path: string;
  has_metadata: boolean;
  ratio: number;
  num_seeds: number;
  num_leechs: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  seq_dl: boolean;
  completion_on: number;
  added_on: number;
  amount_left: number;
  downloaded: number;
  uploaded: number;
}

/** One file from /api/v2/torrents/files. `name` is the path inside the save folder. */
export interface QbitFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}

/** One peer from /api/v2/sync/torrentPeers. */
export interface QbitPeer {
  ip: string;
  port: number;
  client: string;
  /** e.g. "D U I X": see `sayl-admin peers` for the legend */
  flags: string;
  connection: string;
  progress: number;
  up_speed: number;
  dl_speed: number;
  uploaded: number;
  downloaded: number;
}

export type AddSource = { magnet: string } | { file: Buffer; filename: string };

export interface TransferInfo {
  connection_status: string;
  dht_nodes: number;
  dl_rate_limit: number;
  up_rate_limit: number;
  [key: string]: unknown;
}

export class QbitClient {
  private cookie: string | null = null;
  private loggingIn: Promise<void> | null = null;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: QbitOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async login(): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: this.opts.username, password: this.opts.password }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = (await res.text()).trim();
    if (res.status === 403) {
      throw new QbitError('qbittorrent refused the login (too many failed attempts, IP banned for a while)', 403);
    }
    // qBittorrent 5.2+ answers 204 on success and 401 on failure; older versions answer 200 "Ok." or 200 "Fails.".
    const accepted = res.status === 204 || (res.status === 200 && text === 'Ok.');
    if (!accepted) throw new QbitError('qbittorrent login failed: check QBIT_USERNAME and QBIT_PASSWORD', res.status);
    // qBittorrent 5 names the cookie per port (e.g. QBT_SID_8080); older versions use SID.
    const sid = res.headers.getSetCookie().map((c) => c.split(';')[0]!.trim()).find((c) => /SID/i.test(c.split('=')[0]!));
    if (!sid) throw new QbitError('qbittorrent login returned no session cookie', res.status);
    this.cookie = sid;
  }

  private async ensureLogin(): Promise<void> {
    if (this.cookie) return;
    this.loggingIn ??= this.login().finally(() => {
      this.loggingIn = null;
    });
    await this.loggingIn;
  }

  /** Sends an authenticated request, logging in again once if the session expired. */
  async request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    await this.ensureLogin();
    const headers = new Headers(init.headers);
    headers.set('cookie', this.cookie!);
    const res = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 403 && retry) {
      await res.body?.cancel();
      this.cookie = null;
      return this.request(path, init, false);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new QbitError(`qbittorrent ${path} failed with ${res.status}${body ? `: ${body}` : ''}`, res.status);
    }
    return res;
  }

  private form(path: string, fields: Record<string, string>): Promise<Response> {
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
  }

  async version(): Promise<string> {
    return (await (await this.request('/api/v2/app/version')).text()).trim();
  }

  async webApiVersion(): Promise<string> {
    return (await (await this.request('/api/v2/app/webapiVersion')).text()).trim();
  }

  async preferences(): Promise<QbitPreferences> {
    return (await (await this.request('/api/v2/app/preferences')).json()) as QbitPreferences;
  }

  async setPreferences(prefs: QbitPreferences): Promise<void> {
    await (await this.form('/api/v2/app/setPreferences', { json: JSON.stringify(prefs) })).body?.cancel();
  }

  async transferInfo(): Promise<TransferInfo> {
    return (await (await this.request('/api/v2/transfer/info')).json()) as TransferInfo;
  }

  /** All torrents, or only the given hashes. */
  async torrents(hashes?: string[]): Promise<QbitTorrent[]> {
    const q = hashes ? `?hashes=${hashes.join('|')}` : '';
    return (await (await this.request(`/api/v2/torrents/info${q}`)).json()) as QbitTorrent[];
  }

  /** Peers currently connected to a torrent, or null if qBittorrent doesn't know the hash. */
  async peers(hash: string): Promise<QbitPeer[] | null> {
    try {
      const res = await this.request(`/api/v2/sync/torrentPeers?hash=${hash}&rid=0`);
      const data = (await res.json()) as { peers?: Record<string, QbitPeer> };
      return Object.values(data.peers ?? {});
    } catch (err) {
      if (err instanceof QbitError && err.status === 404) return null;
      throw err;
    }
  }

  /** 1 when qBittorrent's alternative (slow) speed limits are switched on. */
  async speedLimitsMode(): Promise<number> {
    return Number((await (await this.request('/api/v2/transfer/speedLimitsMode')).text()).trim());
  }

  /** The torrent's files, or null if qBittorrent doesn't know the hash. */
  async files(hash: string): Promise<QbitFile[] | null> {
    try {
      const res = await this.request(`/api/v2/torrents/files?hash=${hash}`);
      return (await res.json()) as QbitFile[];
    } catch (err) {
      if (err instanceof QbitError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Adds a torrent with the given tags. Magnets start and stop by themselves
   * once metadata arrives; .torrent files are added stopped. Both wait for the
   * user to pick files. Returns false if qBittorrent already has the torrent.
   */
  async add(source: AddSource, tags: string[]): Promise<boolean> {
    const form = new FormData();
    if ('magnet' in source) {
      form.append('urls', source.magnet);
      form.append('stopCondition', 'MetadataReceived');
    } else {
      form.append('torrents', new Blob([new Uint8Array(source.file)]), source.filename);
      form.append('stopped', 'true');
    }
    form.append('tags', tags.join(','));
    form.append('savepath', '/downloads/');
    form.append('contentLayout', 'Subfolder');
    try {
      await (await this.request('/api/v2/torrents/add', { method: 'POST', body: form })).body?.cancel();
      return true;
    } catch (err) {
      if (err instanceof QbitError && err.status === 409) return false;
      throw err;
    }
  }

  private async action(path: string, fields: Record<string, string>): Promise<void> {
    await (await this.form(path, fields)).body?.cancel();
  }

  start(hashes: string[]) {
    return this.action('/api/v2/torrents/start', { hashes: hashes.join('|') });
  }
  stop(hashes: string[]) {
    return this.action('/api/v2/torrents/stop', { hashes: hashes.join('|') });
  }
  recheck(hashes: string[]) {
    return this.action('/api/v2/torrents/recheck', { hashes: hashes.join('|') });
  }
  delete(hashes: string[], deleteFiles: boolean) {
    return this.action('/api/v2/torrents/delete', { hashes: hashes.join('|'), deleteFiles: String(deleteFiles) });
  }
  addTags(hashes: string[], tags: string[]) {
    return this.action('/api/v2/torrents/addTags', { hashes: hashes.join('|'), tags: tags.join(',') });
  }
  removeTags(hashes: string[], tags: string[]) {
    return this.action('/api/v2/torrents/removeTags', { hashes: hashes.join('|'), tags: tags.join(',') });
  }
  /** 0 = don't download, 1 = normal. */
  setFilePriority(hash: string, ids: number[], priority: 0 | 1) {
    return this.action('/api/v2/torrents/filePrio', { hash, id: ids.join('|'), priority: String(priority) });
  }
  toggleSequential(hashes: string[]) {
    return this.action('/api/v2/torrents/toggleSequentialDownload', { hashes: hashes.join('|') });
  }
}

/** Splits qBittorrent's "a, b" tag string. */
export const tagList = (tags: string): string[] =>
  tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
