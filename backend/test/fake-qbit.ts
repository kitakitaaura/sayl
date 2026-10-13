import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny stand-in for qBittorrent's Web API: login with a per-port cookie name
 * (like qBittorrent 5), 403 without a valid session, and preferences storage.
 */
export interface FakeQbit {
  url: string;
  prefs: Record<string, unknown>;
  logins: number;
  /** Drop all sessions, as if qBittorrent restarted. */
  expireSessions(): void;
  /** Make setPreferences ignore these keys, to simulate rejected settings. */
  ignoreKeys: Set<string>;
  close(): Promise<void>;
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * `legacy` mimics qBittorrent before 5.2 (200 "Ok." / 200 "Fails."), otherwise
 * 5.2+ (204 on success, 401 on failure), which is what the Docker image ships.
 */
export async function startFakeQbit(
  username = 'sayl',
  password = 'correct horse battery',
  legacy = false,
): Promise<FakeQbit> {
  const sessions = new Set<string>();
  const state = {
    prefs: { dht: false, pex: false, lsd: false, encryption: 2, listen_port: 1, save_path: '/downloads' } as Record<string, unknown>,
    logins: 0,
    ignoreKeys: new Set<string>(),
  };
  let n = 0;

  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (status: number, text: string, type = 'text/plain') => {
      res.writeHead(status, { 'content-type': type });
      res.end(text);
    };
    if (path === '/api/v2/auth/login' && req.method === 'POST') {
      const form = new URLSearchParams(await body(req));
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
    switch (path) {
      case '/api/v2/app/version':
        return send(200, 'v5.2.4');
      case '/api/v2/app/webapiVersion':
        return send(200, '2.11.4');
      case '/api/v2/app/preferences':
        return send(200, JSON.stringify(state.prefs), 'application/json');
      case '/api/v2/app/setPreferences': {
        const json = JSON.parse(new URLSearchParams(await body(req)).get('json') ?? '{}') as Record<string, unknown>;
        for (const [k, v] of Object.entries(json)) if (!state.ignoreKeys.has(k)) state.prefs[k] = v;
        return send(200, '');
      }
      case '/api/v2/transfer/info':
        return send(200, JSON.stringify({ connection_status: 'connected', dht_nodes: 0, dl_rate_limit: 0, up_rate_limit: 0 }), 'application/json');
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
    ignoreKeys: state.ignoreKeys,
    expireSessions: () => sessions.clear(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
