/**
 * Just enough of the BitTorrent DHT (BEP 5) to find peers for an info hash:
 * an iterative get_peers lookup. Runs over any UDP-like transport, here the
 * TURN client: { send(host, port, bytes), permit(hosts), onmessage }.
 */
import { decode, encode } from './bencode.js';

export const BOOTSTRAP = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.libtorrent.org', port: 25401 },
];

const compactPeers = (values) => {
  const out = [];
  for (const v of values ?? []) {
    if (v instanceof Uint8Array && v.length === 6) out.push({ host: `${v[0]}.${v[1]}.${v[2]}.${v[3]}`, port: (v[4] << 8) | v[5] });
  }
  return out;
};

const compactNodes = (nodes) => {
  const out = [];
  if (!(nodes instanceof Uint8Array)) return out;
  for (let i = 0; i + 26 <= nodes.length; i += 26) {
    const n = nodes.subarray(i, i + 26);
    const port = (n[24] << 8) | n[25];
    if (port) out.push({ id: n.slice(0, 20), host: `${n[20]}.${n[21]}.${n[22]}.${n[23]}`, port });
  }
  return out;
};

function distance(a, b) {
  const d = new Uint8Array(20);
  for (let i = 0; i < 20; i++) d[i] = a[i] ^ b[i];
  return d;
}

function compare(a, b) {
  for (let i = 0; i < 20; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export class Dht {
  constructor(udp) {
    this.udp = udp;
    this.id = crypto.getRandomValues(new Uint8Array(20));
    this.tid = 0;
    this.waiting = new Map(); // tid → resolve
    this.permitted = new Set();
    this.stats = { sent: 0, replies: 0 };
    udp.onmessage = (host, port, bytes) => this.#receive(host, port, bytes);
  }

  #receive(host, port, bytes) {
    let msg;
    try {
      msg = decode(bytes).value;
    } catch {
      return;
    }
    if (!(msg.t instanceof Uint8Array) || msg.t.length !== 2) return;
    const tid = (msg.t[0] << 8) | msg.t[1];
    const resolve = this.waiting.get(tid);
    if (!resolve) return;
    this.waiting.delete(tid);
    this.stats.replies++;
    resolve(msg.y?.[0] === 0x72 /* r */ ? msg.r ?? null : null);
  }

  async #permit(nodes) {
    const fresh = [...new Set(nodes.map((n) => n.host))].filter((h) => !this.permitted.has(h));
    if (!fresh.length) return;
    await this.udp.permit(fresh);
    for (const h of fresh) this.permitted.add(h);
  }

  /** Sends one query and resolves with the reply's "r" dict, or null on timeout or error. */
  query(node, q, args, timeoutMs = 3000) {
    const tid = (this.tid = (this.tid + 1) & 0xffff);
    const t = new Uint8Array([tid >> 8, tid & 255]);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(tid);
        resolve(null);
      }, timeoutMs);
      this.waiting.set(tid, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.stats.sent++;
      this.udp.send(node.host, node.port, encode({ t, y: 'q', q, a: { id: this.id, ...args } }));
    });
  }

  async ping(node) {
    await this.#permit([node]);
    return this.query(node, 'ping', {});
  }

  /**
   * Iterative get_peers. bootstrap: [{host (IPv4), port}].
   * Returns { peers: [{host, port}], rounds, nodesQueried }.
   */
  async getPeers(infoHash, bootstrap, { alpha = 8, maxRounds = 10, enough = 100, onround } = {}) {
    const peers = new Map();
    const seen = new Set();
    let candidates = bootstrap.map((b) => ({ ...b, id: null }));
    let queried = 0;
    let rounds = 0;
    let best = null;
    let stale = 0;
    while (rounds < maxRounds && candidates.length && stale < 3) {
      rounds++;
      const batch = candidates.filter((c) => !seen.has(`${c.host}:${c.port}`)).slice(0, alpha);
      if (!batch.length) break;
      for (const c of batch) seen.add(`${c.host}:${c.port}`);
      await this.#permit(batch);
      queried += batch.length;
      const replies = await Promise.all(batch.map((n) => this.query(n, 'get_peers', { info_hash: infoHash })));
      const found = [];
      for (const r of replies) {
        if (!r) continue;
        for (const p of compactPeers(r.values)) peers.set(`${p.host}:${p.port}`, p);
        found.push(...compactNodes(r.nodes));
      }
      // Keep the closest unqueried nodes we know of, closest first.
      const all = new Map([...candidates, ...found].map((n) => [`${n.host}:${n.port}`, n]));
      candidates = [...all.values()]
        .filter((n) => n.id && !seen.has(`${n.host}:${n.port}`))
        .sort((a, b) => compare(distance(a.id, infoHash), distance(b.id, infoHash)));
      const closest = candidates[0] ? distance(candidates[0].id, infoHash) : null;
      if (closest && (!best || compare(closest, best) < 0)) {
        best = closest;
        stale = 0;
      } else {
        stale++;
      }
      onround?.({ round: rounds, queried, peers: peers.size, replies: replies.filter(Boolean).length, asked: batch.length });
      if (peers.size >= enough) break;
    }
    return { peers: [...peers.values()], rounds, nodesQueried: queried };
  }
}
