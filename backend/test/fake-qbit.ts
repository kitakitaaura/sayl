import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decode, type BDict, type BValue } from '../src/bencode.js';

/**
 * An in-memory stand-in for qBittorrent 5.2's Web API, covering what Sayl
 * uses: login (per-port cookie, 204/401), preferences, and torrents with tags,
 * files, priorities, start/stop, recheck and delete. Test hooks simulate
 * metadata arriving and downloads finishing.
 */
export interface FakeFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
}

export interface FakeTorrent {
  hash: string;
  name: string;
  state: string;
  tags: Set<string>;
  files: FakeFile[];
  has_metadata: boolean;
  seq_dl: boolean;
  ratio: number;
  dlspeed: number;
  upspeed: number;
  num_seeds: number;
  num_leechs: number;
  uploaded: number;
  added_on: number;
  /** what was submitted to torrents/add */
  addedWith: Record<string, string>;
}

export interface FakeQbit {
  url: string;
  prefs: Record<string, unknown>;
  logins: number;
  torrents: Map<string, FakeTorrent>;
  deleted: { hash: string; deleteFiles: boolean }[];
  calls: string[];
  ignoreKeys: Set<string>;
  expireSessions(): void;
  /** Simulates a magnet's metadata arriving. */
  giveMetadata(hash: string, name: string, files: { name: string; size: number }[]): void;
  /** Marks the given files (default: every wanted file) as fully downloaded. */
  complete(hash: string, indexes?: number[]): void;
  close(): Promise<void>;
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function torrentProgress(t: FakeTorrent): number {
  const wanted = t.files.filter((f) => f.priority > 0);
  const size = wanted.reduce((s, f) => s + f.size, 0);
  if (!size) return 0;
  return wanted.reduce((s, f) => s + f.size * f.progress, 0) / size;
}

function info(t: FakeTorrent) {
  const wanted = t.files.filter((f) => f.priority > 0);
  const progress = torrentProgress(t);
  return {
    hash: t.hash,
    name: t.name,
    state: t.state,
    progress,
    size: wanted.reduce((s, f) => s + f.size, 0),
    total_size: t.has_metadata ? t.files.reduce((s, f) => s + f.size, 0) : -1,
    tags: [...t.tags].join(', '),
    save_path: '/downloads',
    content_path: t.has_metadata ? `/downloads/${t.name}` : '',
    has_metadata: t.has_metadata,
    ratio: t.ratio,
    num_seeds: t.num_seeds,
    num_leechs: t.num_leechs,
    dlspeed: t.dlspeed,
    upspeed: t.upspeed,
    eta: 8640000,
    seq_dl: t.seq_dl,
    completion_on: -1,
    added_on: t.added_on,
    amount_left: 0,
    downloaded: 0,
    uploaded: t.uploaded,
  };
}

const str = (v: BValue | undefined) => (Buffer.isBuffer(v) ? v.toString('utf8') : '');

function parseTorrent(buf: Buffer): { hash: string; name: string; files: { name: string; size: number }[] } {
  const span = { start: 0, end: 0 };
  const root = decode(buf, span) as BDict;
  const inf = root.info as BDict;
  const name = str(inf.name);
  const files =
    typeof inf.length === 'number'
      ? [{ name, size: inf.length }]
      : (inf.files as BDict[]).map((f) => ({ name: [name, ...(f.path as Buffer[]).map((p) => p.toString('utf8'))].join('/'), size: f.length as number }));
  return { hash: createHash('sha1').update(buf.subarray(span.start, span.end)).digest('hex'), name, files };
}

export async function startFakeQbit(username = 'sayl', password = 'correct horse battery', legacy = false): Promise<FakeQbit> {
  const sessions = new Set<string>();
  const torrents = new Map<string, FakeTorrent>();
  const deleted: { hash: string; deleteFiles: boolean }[] = [];
  const calls: string[] = [];
  const state = {
    prefs: { dht: false, pex: false, lsd: false, encryption: 2, listen_port: 1, save_path: '/downloads' } as Record<string, unknown>,
    logins: 0,
    ignoreKeys: new Set<string>(),
  };
  let n = 0;

  const makeFiles = (files: { name: string; size: number }[]): FakeFile[] =>
    files.map((f, index) => ({ index, name: f.name, size: f.size, progress: 0, priority: 1 }));

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const send = (status: number, text = '', type = 'text/plain') => {
      res.writeHead(status, { 'content-type': type });
      res.end(text);
    };
    const json = (v: unknown) => send(200, JSON.stringify(v), 'application/json');

    if (path === '/api/v2/auth/login' && req.method === 'POST') {
      const form = new URLSearchParams((await body(req)).toString());
      if (form.get('username') !== username || form.get('password') !== password) {
        return legacy ? send(200, 'Fails.') : send(401, 'Unauthorized');
      }
      const sid = `sid${++n}`;
      sessions.add(sid);
      state.logins++;
      res.setHeader('set-cookie', `QBT_SID_8080=${sid}; HttpOnly; SameSite=Lax; path=/`);
      if (legacy) return send(200, 'Ok.');
      res.writeHead(204);
      return res.end();
    }
    const sid = /QBT_SID_8080=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!sid || !sessions.has(sid)) return send(403, 'Forbidden');

    const raw = req.method === 'POST' ? await body(req) : Buffer.alloc(0);
    const form = () => new URLSearchParams(raw.toString());
    const hashes = (v: string | null) => (v ?? '').split('|').filter(Boolean);
    calls.push(path);

    switch (path) {
      case '/api/v2/app/version':
        return send(200, 'v5.2.4');
      case '/api/v2/app/webapiVersion':
        return send(200, '2.15.1');
      case '/api/v2/app/preferences':
        return json(state.prefs);
      case '/api/v2/app/setPreferences': {
        const prefs = JSON.parse(form().get('json') ?? '{}') as Record<string, unknown>;
        for (const [k, v] of Object.entries(prefs)) if (!state.ignoreKeys.has(k)) state.prefs[k] = v;
        return send(200);
      }
      case '/api/v2/transfer/info':
        return json({ connection_status: 'connected', dht_nodes: 0, dl_rate_limit: 0, up_rate_limit: 0 });
      case '/api/v2/torrents/info': {
        const want = url.searchParams.get('hashes');
        const list = [...torrents.values()].filter((t) => !want || hashes(want).includes(t.hash));
        return json(list.map(info));
      }
      case '/api/v2/torrents/files': {
        const t = torrents.get(url.searchParams.get('hash') ?? '');
        if (!t) return send(404, 'Not Found');
        return json(t.has_metadata ? t.files.map((f) => ({ ...f })) : []);
      }
      case '/api/v2/torrents/add': {
        const fd = await new Request('http://x/', { method: 'POST', headers: req.headers as Record<string, string>, body: raw }).formData();
        const fields: Record<string, string> = {};
        for (const [k, v] of fd.entries()) if (typeof v === 'string') fields[k] = v;
        const tags = new Set((fields.tags ?? '').split(',').filter(Boolean));
        const file = fd.get('torrents');
        let t: FakeTorrent;
        const base = { tags, seq_dl: false, ratio: 0, dlspeed: 0, upspeed: 0, num_seeds: 5, num_leechs: 2, uploaded: 0, added_on: Math.floor(Date.now() / 1000), addedWith: fields };
        if (file && typeof file !== 'string') {
          const p = parseTorrent(Buffer.from(await file.arrayBuffer()));
          if (torrents.has(p.hash)) return send(409, 'Conflict');
          t = { ...base, hash: p.hash, name: p.name, state: fields.stopped === 'true' ? 'stoppedDL' : 'downloading', files: makeFiles(p.files), has_metadata: true };
        } else {
          const m = /xt=urn:btih:([0-9a-f]{40})/.exec(fields.urls ?? '');
          if (!m) return send(400, 'Bad Request');
          if (torrents.has(m[1]!)) return send(409, 'Conflict');
          const dn = new URLSearchParams((fields.urls ?? '').split('?')[1]).get('dn');
          t = { ...base, hash: m[1]!, name: dn ?? m[1]!, state: 'metaDL', files: [], has_metadata: false };
        }
        torrents.set(t.hash, t);
        return json({ added_torrent_ids: [t.hash], failure_count: 0, pending_count: 0, success_count: 1 });
      }
      case '/api/v2/torrents/start':
      case '/api/v2/torrents/stop':
      case '/api/v2/torrents/recheck':
      case '/api/v2/torrents/toggleSequentialDownload': {
        for (const h of hashes(form().get('hashes'))) {
          const t = torrents.get(h);
          if (!t) continue;
          const done = t.has_metadata && torrentProgress(t) >= 1;
          if (path.endsWith('/start')) t.state = !t.has_metadata ? 'metaDL' : done ? 'stalledUP' : 'downloading';
          if (path.endsWith('/stop')) t.state = done ? 'stoppedUP' : 'stoppedDL';
          if (path.endsWith('/recheck')) t.state = 'checkingDL';
          if (path.endsWith('Download')) t.seq_dl = !t.seq_dl;
        }
        return send(200);
      }
      case '/api/v2/torrents/delete': {
        const f = form();
        for (const h of hashes(f.get('hashes'))) {
          if (torrents.delete(h)) deleted.push({ hash: h, deleteFiles: f.get('deleteFiles') === 'true' });
        }
        return send(200);
      }
      case '/api/v2/torrents/addTags':
      case '/api/v2/torrents/removeTags': {
        const f = form();
        for (const h of hashes(f.get('hashes'))) {
          const t = torrents.get(h);
          for (const tag of (f.get('tags') ?? '').split(',').filter(Boolean)) {
            if (path.endsWith('addTags')) t?.tags.add(tag);
            else t?.tags.delete(tag);
          }
        }
        return send(200);
      }
      case '/api/v2/torrents/filePrio': {
        const f = form();
        const t = torrents.get(f.get('hash') ?? '');
        if (!t) return send(404, 'Not Found');
        for (const id of hashes(f.get('id'))) {
          const file = t.files[Number(id)];
          if (file) file.priority = Number(f.get('priority'));
        }
        return send(200);
      }
      default:
        return send(404, 'Not Found');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get prefs() {
      return state.prefs;
    },
    get logins() {
      return state.logins;
    },
    torrents,
    deleted,
    calls,
    ignoreKeys: state.ignoreKeys,
    expireSessions: () => sessions.clear(),
    giveMetadata(hash, name, files) {
      const t = torrents.get(hash);
      if (!t) throw new Error('no such torrent');
      t.name = name;
      t.files = makeFiles(files);
      t.has_metadata = true;
      // the add used stopCondition=MetadataReceived
      if (t.addedWith.stopCondition === 'MetadataReceived') t.state = 'stoppedDL';
    },
    complete(hash, indexes) {
      const t = torrents.get(hash);
      if (!t) throw new Error('no such torrent');
      for (const f of t.files) if (indexes ? indexes.includes(f.index) : f.priority > 0) f.progress = 1;
      if (torrentProgress(t) >= 1 && !t.state.startsWith('stopped')) t.state = 'stalledUP';
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
