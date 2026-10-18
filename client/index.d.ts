/** Types for the parts of the client the website uses. The implementation is plain JS. */

export interface TorrentFile {
  /** path inside the torrent, "/"-separated */
  path: string;
  length: number;
  /** where the file starts in the torrent's byte stream */
  offset: number;
}

export interface Info {
  raw: Uint8Array;
  name: string;
  files: TorrentFile[];
  length: number;
  pieceLength: number;
  pieceCount: number;
  pieceHash(i: number): Uint8Array;
  pieceSize(i: number): number;
}

export interface Source {
  infoHash: string;
  name?: string | null;
  trackers: string[];
  peers: string[];
  info?: Info;
}

export interface Relay {
  url: string;
  via?: 'worker' | 'do';
  session?: string;
  token?: string;
}

export interface TurnServer {
  url: string;
  username: string;
  credential: string;
}

export interface Sink {
  open?(info: Info): unknown | Promise<unknown>;
  write?(offset: number, bytes: Uint8Array, piece: number): unknown | Promise<unknown>;
  close?(): unknown | Promise<unknown>;
}

export interface Progress {
  name: string | null;
  size: number | null;
  verifiedBytes: number;
  bytesPerSecond: number;
  uploadedBytes: number;
  uploadBytesPerSecond: number;
  /** everything wanted is in and the download stays up to share */
  seeding: boolean;
  peersKnown: number;
  peersConnected: number;
  peersUnchoked: number;
  seeds: number;
  hasMetadata: boolean;
  fraction: number;
}

export interface Summary {
  name: string | null;
  size: number | null;
  complete: boolean;
  stopReason: string | null;
  verifiedBytes: number;
  uploadedBytes: number;
  averageMBps: number;
  dht: string;
  [key: string]: unknown;
}

export interface DownloadOptions {
  relay: Relay;
  source: Source;
  sink: Sink;
  maxPeers?: number;
  pipeline?: number;
  limitBytes?: number;
  extraTrackers?: boolean;
  dht?: { getTurn: () => Promise<TurnServer[]>; bootstrap?: { host: string; port: number }[] } | null;
  wanted?: 'all' | Uint8Array | null;
  have?: Uint8Array | null;
  sequential?: boolean;
  /** share too: answer requests for the pieces we have, and keep seeding once complete, until stop() */
  seed?: boolean;
  /** reads a verified piece back from storage; needed with `seed` */
  read?: ((piece: number) => Promise<Uint8Array | null>) | null;
  /** peers unchoked at once while sharing (default 4) */
  uploadSlots?: number;
  /** also connect straight to other browsers over WebRTC, found through these WebTorrent trackers (browser only) */
  webrtc?: { trackers: string[]; iceServers?: RTCIceServer[]; maxPeers?: number } | null;
  log?: (line: string) => void;
}

export class Download {
  constructor(options: DownloadOptions);
  info: Info | null;
  stopped: boolean;
  stopReason?: string;
  readonly have: Uint8Array | null;
  onprogress: ((p: Progress) => void) | null;
  onmetadata: ((info: Info) => void) | null;
  onpiece: ((piece: number) => void) | null;
  oncomplete: (() => void) | null;
  readonly seeding: boolean;
  start(): Promise<Summary>;
  stop(reason?: string): void;
  select(wanted: Uint8Array): void;
  sequentialMode: boolean;
  progress(): Progress;
  summary(): Summary;
}

export function parseMagnet(uri: string): { infoHash: string; name: string | null; trackers: string[]; peers: string[] };
export function parseTorrentFile(bytes: Uint8Array): Promise<{ infoHash: string; trackers: string[]; peers: string[]; info: Info }>;
export function parseInfo(raw: Uint8Array): Info;
export function hex(bytes: Uint8Array): string;
export function fromHex(s: string): Uint8Array;
export function sha1(bytes: Uint8Array): Promise<Uint8Array>;
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean;
/** TURN logins from the relay, or from `fallback` (e.g. the website's /api/turn) when the relay has none. */
export function fetchTurnServers(relay: Relay, options?: { fallback?: string }): Promise<TurnServer[]>;
export function pieceSegments(info: Info, piece: number): { file: number; fileOffset: number; pieceOffset: number; length: number }[];
export function piecesForFiles(info: Info, fileIndexes: Iterable<number>): Uint8Array;
export function fileProgress(info: Info, have: Uint8Array): number[];
export function safePathParts(path: string): string[];
export const BUNDLED_TRACKERS: string[];
export const WEBRTC_TRACKERS: string[];
export function webrtcSupported(): boolean;
/** A .zip (stored, ZIP64 when needed) built from the files themselves, so big files stay on disk. */
export function makeZip(
  files: { path: string; blob: Blob }[],
  options?: { onprogress?: (readBytes: number, totalBytes: number) => void; signal?: AbortSignal },
): Promise<Blob>;
export function loadPublicTrackers(options?: { timeoutMs?: number }): Promise<string[]>;

export interface CreatedTorrent {
  infoHash: string;
  info: Info;
  /** the .torrent file */
  torrent: Uint8Array;
  magnet: string;
}
/** Makes a v1 torrent. One file: a single-file torrent named after it; more: a folder called `name`. */
export function createTorrent(options: {
  name?: string;
  files: { path: string[]; blob: Blob }[];
  trackers?: string[];
  pieceLength?: number;
  onprogress?: (hashedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  createdBy?: string;
}): Promise<CreatedTorrent>;
export function pickPieceLength(totalBytes: number): number;
/** A .torrent file around an info dict's exact bytes. */
export function torrentFile(infoRaw: Uint8Array, trackers?: string[], options?: { createdBy?: string; createdAt?: number }): Uint8Array;
/** A magnet link with the name, size and up to 10 trackers. */
export function magnetLink(infoHash: string, name: string, length?: number, trackers?: string[]): string;
