/** Typed client for the Sayl API. Every request sends the session cookie. */
import { API_URL } from './config';

export type ViewState = 'metadata' | 'selecting' | 'queued' | 'downloading' | 'stalled' | 'checking' | 'paused' | 'seeding' | 'done' | 'error';

export interface TorrentView {
  hash: string;
  name: string;
  state: ViewState;
  progress: number;
  totalSize: number | null;
  selectedSize: number | null;
  downloaded: number;
  dlSpeed: number;
  upSpeed: number;
  eta: number | null;
  peers: number;
  seeds: number;
  ratio: number;
  fileCount: number | null;
  paused: boolean;
  seed: boolean;
  ratioLimit: number;
  sequential: boolean;
  addedAt: number;
  completedAt: number | null;
  seedEndsAt: number | null;
}

export interface FileView {
  index: number;
  path: string;
  size: number;
  progress: number;
  selected: boolean | null;
}

export interface Limits {
  maxActive: number;
  maxStorageGb: number;
  maxTorrentGb: number;
  maxTorrentFileKb: number;
  retention: { maxGb: number; hours: number }[];
  seedMaxMinutes: number;
  defaultRatioLimit: number;
}

export interface SessionInfo {
  app: string;
  session: { active: true } | null;
  /** what a new session needs */
  access: { code: boolean; captcha: boolean };
  limits: Limits;
}

export interface Links {
  expiresAt: number;
  files: { index: number; path: string; size: number; url: string }[];
  zip: { url: string } | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      credentials: 'include',
      headers: body !== undefined && !isForm ? { 'content-type': 'application/json' } : undefined,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', "can't reach sayl right now. check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // non-json error page from a proxy
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, d.error ?? 'error', d.message ?? 'something went wrong. try again.');
  }
  return data as T;
}

export type Action = 'pause' | 'resume' | 'recheck' | 'stop-seeding';

export const api = {
  session: () => request<SessionInfo>('GET', '/api/session'),
  startSession: (body?: { accessCode?: string; captchaToken?: string }) =>
    request<{ session: { active: true } }>('POST', '/api/session', body),
  endSession: () => request<void>('DELETE', '/api/session'),
  torrents: () => request<{ torrents: TorrentView[] }>('GET', '/api/torrents'),
  add: (source: string) => request<{ torrent: TorrentView }>('POST', '/api/torrents', { source }),
  upload: (file: File) => {
    const form = new FormData();
    form.append('torrent', file, file.name);
    return request<{ torrent: TorrentView }>('POST', '/api/torrents', form);
  },
  files: (hash: string) => request<{ files: FileView[] }>('GET', `/api/torrents/${hash}/files`),
  select: (hash: string, body: { files: number[]; seed: boolean; sequential: boolean; ratioLimit: number }) =>
    request<{ torrent: TorrentView }>('POST', `/api/torrents/${hash}/select`, body),
  action: (hash: string, action: Action) => request<{ torrent: TorrentView }>('POST', `/api/torrents/${hash}/${action}`),
  remove: (hash: string) => request<void>('DELETE', `/api/torrents/${hash}`),
  removeAll: () => request<{ removed: number }>('DELETE', '/api/torrents'),
  links: (hash: string) => request<Links>('GET', `/api/torrents/${hash}/links`),
};

export const EVENTS_URL = `${API_URL}/api/events`;
