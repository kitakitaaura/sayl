/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/**
 * Plays torrents while they download (browser engine). A <video> or <audio> on the page points at
 * /stream/<hash>/<file index>/<name>; this worker answers its byte-range requests by asking the page,
 * which reads the bytes from the torrent's storage, waiting for (and fetching first) pieces not in yet.
 * Everything else goes to the network as usual: this worker caches nothing.
 */
import { mediaType } from '$lib/media';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CHUNK = 1024 * 1024;
sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', (e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== sw.location.origin || !url.pathname.startsWith('/stream/')) return;
  e.respondWith(stream(e, url));
});

interface Answer {
  ok: boolean;
  total?: number;
  bytes?: Uint8Array;
  error?: string;
}

/** Asks a page of this site for bytes of a file. */
async function ask(clientId: string, req: { hash: string; index: number; offset: number; length: number }): Promise<Answer> {
  let client = clientId ? await sw.clients.get(clientId) : undefined;
  if (!client) {
    const all = await sw.clients.matchAll({ type: 'window' });
    client = all.find((c) => (c as WindowClient).focused) ?? all[0];
  }
  if (!client) return { ok: false, error: 'no open page to read from' };
  const channel = new MessageChannel();
  const answer = new Promise<Answer>((resolve) => {
    channel.port1.onmessage = (m) => resolve(m.data as Answer);
  });
  client.postMessage({ type: 'sayl-read', ...req }, [channel.port2]);
  return answer;
}

async function stream(e: FetchEvent, url: URL): Promise<Response> {
  const [, , hash, indexText, name = ''] = url.pathname.split('/');
  const index = Number(indexText);
  if (!/^[0-9a-f]{40}$/.test(hash ?? '') || !Number.isInteger(index) || index < 0) return new Response('not found', { status: 404 });
  const type = mediaType(decodeURIComponent(name)) ?? 'application/octet-stream';

  const range = /^bytes=(\d+)-(\d*)$/.exec(e.request.headers.get('range') ?? '');
  const start = range ? Number(range[1]) : 0;
  // the first chunk also tells us the file's size
  const first = await ask(e.clientId, { hash, index, offset: start, length: CHUNK });
  if (!first.ok || first.total === undefined || !first.bytes) return new Response(first.error ?? 'unavailable', { status: 503 });
  const total = first.total;
  if (start >= total && total > 0) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
  const end = range && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;

  let pos = start;
  let pending: Uint8Array | null = first.bytes;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let bytes = pending;
      pending = null;
      if (!bytes) {
        const next = await ask(e.clientId, { hash, index, offset: pos, length: Math.min(CHUNK, end + 1 - pos) });
        if (!next.ok || !next.bytes?.length) return controller.error(new Error(next.error ?? 'read failed'));
        bytes = next.bytes;
      }
      bytes = bytes.subarray(0, end + 1 - pos);
      pos += bytes.length;
      controller.enqueue(bytes);
      if (pos > end) controller.close();
    },
  });
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-length': String(end + 1 - start),
    'cache-control': 'no-store',
  };
  if (!range) return new Response(body, { status: 200, headers });
  return new Response(body, { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${total}` } });
}
