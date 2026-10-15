/**
 * Downloads one torrent from the swarm through the relay. Runs in the browser
 * or in Node 22+ (it only needs WebSocket and crypto.subtle).
 *
 *   const d = new Download({ relay, source, sink });
 *   d.onprogress = (stats) => …;
 *   await d.start();          // resolves when done (or stopped)
 *
 * source: { infoHash (hex), trackers, peers: ['host:port'], info? }
 * sink:   { open(info), write(offset, bytes), close() } — writes may arrive in any order
 */
import { MSG, EXT, Wire, parseMetadataMessage, parsePex } from './wire.js';
import { announce, announceUrls, EXTRA_TRACKERS } from './tracker.js';
import { openTunnel } from './tunnel.js';
import { equalBytes, fromHex, hex, parseInfo, sha1 } from './torrent.js';

const BLOCK = 16 * 1024;
const METADATA_PIECE = 16 * 1024;
const MAX_METADATA = 16 * 1024 * 1024;
const SNUB_MS = 20_000;

export class Download {
  constructor({ relay, source, sink, maxPeers = 40, pipeline = 64, limitBytes = Infinity, extraTrackers = true, log = () => {} }) {
    this.relay = relay;
    this.source = source;
    this.sink = sink;
    this.maxPeers = maxPeers;
    this.pipeline = pipeline;
    this.limitBytes = limitBytes;
    this.log = log;
    this.infoHash = fromHex(source.infoHash);
    this.peerId = new TextEncoder().encode(`-SY0001-${Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join('')}`);
    this.trackers = announceUrls([...(source.trackers ?? []), ...(extraTrackers ? EXTRA_TRACKERS : [])]);
    this.info = null;
    this.known = new Map(); // "host:port" → { host, port, tried }
    this.peers = new Set();
    this.connecting = 0;
    this.stats = {
      started: 0,
      metadataAt: null,
      firstPieceAt: null,
      finishedAt: null,
      verifiedBytes: 0,
      receivedBytes: 0,
      wastedBytes: 0,
      hashFailures: 0,
      messagesOut: 0,
      found: 0,
      tried: 0,
      connected: 0,
      handshaken: 0,
      failures: {},
      trackers: {},
    };
    this.metadata = null; // { size, pieces: [], got }
    this.active = new Map(); // piece → { buf, blocks: Uint8Array (0 free, 1 requested, 2 received), left, by: Map(block → Set(peer)) }
    this.done = null; // Uint8Array per piece: 0 = missing, 1 = verified, 2 = being verified
    this.verifying = 0;
    this.remaining = 0;
    this.stopped = false;
    this.onprogress = null;
  }

  async start() {
    this.stats.started = Date.now();
    this.finished = new Promise((resolve) => (this.#resolve = resolve));
    if (this.source.info) await this.#setInfo(this.source.info);
    for (const p of this.source.peers ?? []) this.#addPeer(p, 'given');
    this.#announceAll('started');
    this.ticker = setInterval(() => this.#tick(), 1000);
    this.announcer = setInterval(() => this.#announceAll(), 60_000);
    return this.finished;
  }

  #resolve = () => {};

  stop(reason = 'stopped') {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    clearInterval(this.ticker);
    clearInterval(this.announcer);
    for (const p of this.peers) p.wire.close('download stopped');
    Promise.resolve(this.info ? this.sink.close?.() : undefined).finally(() => this.#resolve(this.summary()));
  }

  summary() {
    const s = this.stats;
    const end = s.finishedAt ?? Date.now();
    const transferStart = s.metadataAt ?? s.started;
    const secs = Math.max(0.001, (end - transferStart) / 1000);
    return {
      name: this.info?.name ?? this.source.name ?? null,
      size: this.info?.length ?? null,
      complete: this.remaining === 0 && !!this.info,
      stopReason: this.stopReason ?? null,
      metadataSeconds: s.metadataAt ? (s.metadataAt - s.started) / 1000 : null,
      firstPieceSeconds: s.firstPieceAt ? (s.firstPieceAt - s.started) / 1000 : null,
      verifiedBytes: s.verifiedBytes,
      receivedBytes: s.receivedBytes,
      wastedBytes: s.wastedBytes,
      hashFailures: s.hashFailures,
      averageMBps: s.verifiedBytes / 1e6 / secs,
      // what a Durable Object relay bills: incoming WebSocket messages (20 count as one request)
      relayMessagesPerGB: s.verifiedBytes ? Math.round((s.messagesOut + [...this.peers].reduce((n, p) => n + p.wire.tunnel.messagesOut, 0)) / (s.verifiedBytes / 1e9)) : null,
      peersFound: s.found,
      peersTried: s.tried,
      peersConnected: s.connected,
      peersHandshaken: s.handshaken,
      connectFailures: s.failures,
      trackers: s.trackers,
    };
  }

  // ── peers ───────────────────────────────────────────────────────────────

  #addPeer(p, from) {
    const [host, port] = typeof p === 'string' ? splitHostPort(p) : [p.host, p.port];
    if (!host || !port) return;
    const key = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    if (this.known.has(key)) return;
    this.known.set(key, { host, port, tried: false, from });
    this.stats.found++;
  }

  async #announceAll(event) {
    if (this.stopped) return;
    const left = this.info ? this.remaining * this.info.pieceLength : 1;
    await Promise.all(
      this.trackers.map(async (url) => {
        try {
          const r = await announce(this.relay, url, { infoHash: this.infoHash, peerId: this.peerId, left, downloaded: this.stats.verifiedBytes, event });
          this.stats.trackers[url] = `${r.peers.length} peers`;
          for (const p of r.peers) this.#addPeer(p, 'tracker');
        } catch (err) {
          this.stats.trackers[url] = `failed: ${err.message}`;
        }
      }),
    );
  }

  #tick() {
    if (this.stopped) return;
    const now = Date.now();
    // Open more connections, a few at a time.
    let budget = 10;
    for (const [key, k] of this.known) {
      if (budget <= 0 || this.peers.size + this.connecting >= this.maxPeers) break;
      if (k.tried) continue;
      k.tried = true;
      budget--;
      this.#connect(key, k);
    }
    const untried = [...this.known.values()].some((k) => !k.tried);
    for (const peer of this.peers) {
      // Make room: a peer that has kept us choked for 90 s goes, if there are others to try.
      if (peer.wire.peerChoking && untried && this.peers.size + this.connecting >= this.maxPeers && now - peer.lastUnchokedAt > 90_000) {
        peer.wire.close('kept us choked');
        continue;
      }
      if (!peer.wire.peerChoking) peer.lastUnchokedAt = now;
      // A peer that has requests out but sent nothing for a while gives them back.
      if (peer.inflight.size && now - peer.lastBlockAt > SNUB_MS) {
        this.#release(peer);
        peer.snubbed = true;
        peer.lastBlockAt = now;
      }
      if (this.metadata && peer.wantsMetadata) this.#askMetadata(peer);
      this.#fill(peer);
    }
    this.onprogress?.(this.progress());
  }

  progress() {
    const s = this.stats;
    const secs = (Date.now() - (this.lastProgressAt ?? s.started)) / 1000;
    const rate = secs > 0 ? (s.verifiedBytes - (this.lastVerified ?? 0)) / secs : 0;
    this.lastProgressAt = Date.now();
    this.lastVerified = s.verifiedBytes;
    let unchoked = 0;
    for (const p of this.peers) if (!p.wire.peerChoking) unchoked++;
    return {
      name: this.info?.name ?? null,
      size: this.info?.length ?? null,
      verifiedBytes: s.verifiedBytes,
      bytesPerSecond: rate,
      peersKnown: this.known.size,
      peersConnected: this.peers.size,
      peersUnchoked: unchoked,
      hasMetadata: !!this.info,
      fraction: this.info ? s.verifiedBytes / this.info.length : 0,
    };
  }

  async #connect(key, k) {
    this.connecting++;
    this.stats.tried++;
    let tunnel;
    try {
      tunnel = await openTunnel(this.relay, { host: k.host, port: k.port });
    } catch (err) {
      this.connecting--;
      this.#countFailure(err.message);
      return;
    }
    if (this.stopped) {
      this.connecting--;
      return tunnel.close();
    }
    this.stats.connected++;
    // Until the handshake, the connection still counts as "connecting", so it holds a slot.
    let handshaking = true;
    const handshakeTimer = setTimeout(() => peer.wire.close('no handshake'), 15_000);
    const settle = () => {
      if (!handshaking) return;
      handshaking = false;
      clearTimeout(handshakeTimer);
      this.connecting--;
    };
    const peer = {
      key,
      inflight: new Set(), // "piece:block"
      have: null, // Uint8Array per piece, once we know the piece count
      pendingBitfield: null,
      pendingHaves: [],
      lastBlockAt: Date.now(),
      lastUnchokedAt: Date.now(),
      snubbed: false,
      maxInflight: this.pipeline,
      wantsMetadata: false,
    };
    peer.wire = new Wire(tunnel, { infoHash: this.infoHash, peerId: this.peerId }, {
      onHandshake: () => {
        settle();
        this.stats.handshaken++;
        this.peers.add(peer);
        this.#applyHaves(peer); // a peer with nothing to offer may never send a bitfield
        peer.wire.interested();
      },
      onExtHandshake: (ext) => {
        if (Number.isInteger(ext.reqq) && ext.reqq > 0) peer.maxInflight = Math.min(this.pipeline, ext.reqq);
        if (!this.info && ext.m?.ut_metadata && Number.isInteger(ext.metadata_size)) {
          if (!this.metadata && ext.metadata_size > 0 && ext.metadata_size <= MAX_METADATA) {
            const count = Math.ceil(ext.metadata_size / METADATA_PIECE);
            this.metadata = { size: ext.metadata_size, pieces: new Array(count).fill(null), asked: new Map() };
          }
          peer.wantsMetadata = !!this.metadata && ext.metadata_size === this.metadata.size;
          this.#askMetadata(peer);
        }
      },
      onExtended: (id, body) => this.#extended(peer, id, body),
      onMessage: (id, payload) => this.#message(peer, id, payload),
      onClose: (reason) => {
        if (handshaking) {
          settle();
          this.#countFailure(reason);
        }
        this.stats.messagesOut += tunnel.messagesOut;
        this.peers.delete(peer);
        this.#release(peer);
      },
    });
  }

  #countFailure(message) {
    const reason = String(message || 'closed').replace(/: .*/, '').slice(0, 40);
    this.stats.failures[reason] = (this.stats.failures[reason] ?? 0) + 1;
  }

  #extended(peer, id, body) {
    if (id === EXT.ut_pex) {
      try {
        for (const p of parsePex(body)) this.#addPeer(p, 'pex');
      } catch {}
      return;
    }
    if (id !== EXT.ut_metadata || this.info || !this.metadata) return;
    let m;
    try {
      m = parseMetadataMessage(body);
    } catch {
      return;
    }
    if (m.type === 2) {
      peer.wantsMetadata = false;
      return;
    }
    if (m.type !== 1 || !Number.isInteger(m.piece) || m.piece < 0 || m.piece >= this.metadata.pieces.length) return;
    const expected = m.piece === this.metadata.pieces.length - 1 ? this.metadata.size - METADATA_PIECE * m.piece : METADATA_PIECE;
    if (m.data.length !== expected) return;
    this.metadata.pieces[m.piece] = m.data.slice();
    this.metadata.asked.delete(m.piece);
    if (this.metadata.pieces.every(Boolean)) {
      const raw = new Uint8Array(this.metadata.size);
      this.metadata.pieces.forEach((p, i) => raw.set(p, i * METADATA_PIECE));
      sha1(raw).then((h) => {
        if (this.info) return;
        if (!equalBytes(h, this.infoHash)) {
          this.log('metadata hash mismatch, starting over');
          this.metadata.pieces.fill(null);
          return;
        }
        this.#setInfo(parseInfo(raw));
      });
    } else {
      this.#askMetadata(peer);
    }
  }

  #askMetadata(peer) {
    if (this.info || !this.metadata) return;
    const now = Date.now();
    for (let i = 0; i < this.metadata.pieces.length; i++) {
      if (this.metadata.pieces[i]) continue;
      const askedAt = this.metadata.asked.get(i);
      if (askedAt && now - askedAt < 5000) continue;
      if (peer.wire.requestMetadata(i)) this.metadata.asked.set(i, now);
      return;
    }
  }

  async #setInfo(info) {
    if (this.info) return;
    this.info = info;
    this.done = new Uint8Array(info.pieceCount);
    this.remaining = info.pieceCount;
    this.stats.metadataAt = Date.now();
    this.log(`metadata: ${info.name}, ${info.files.length} file(s), ${(info.length / 1e6).toFixed(1)} MB, ${info.pieceCount} pieces of ${info.pieceLength / 1024} KiB`);
    try {
      await this.sink.open?.(info);
    } catch (err) {
      this.stop(`couldn't save: ${err.message}`);
      return;
    }
    for (const peer of this.peers) this.#applyHaves(peer);
  }

  #applyHaves(peer) {
    if (!this.info || peer.have) return;
    peer.have = new Uint8Array(this.info.pieceCount);
    if (peer.pendingBitfield) {
      const bf = peer.pendingBitfield;
      for (let i = 0; i < this.info.pieceCount; i++) if (bf[i >> 3] & (0x80 >> (i & 7))) peer.have[i] = 1;
    }
    for (const i of peer.pendingHaves) if (i < this.info.pieceCount) peer.have[i] = 1;
    peer.pendingBitfield = null;
    peer.pendingHaves = [];
  }

  #message(peer, id, payload) {
    const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    switch (id) {
      case MSG.bitfield:
        peer.pendingBitfield = payload.slice();
        peer.have = null;
        this.#applyHaves(peer);
        break;
      case MSG.have: {
        if (payload.length < 4) return;
        const i = v.getUint32(0);
        if (peer.have) {
          if (i < peer.have.length) peer.have[i] = 1;
        } else peer.pendingHaves.push(i);
        break;
      }
      case MSG.choke:
        this.#release(peer);
        break;
      case MSG.piece:
        if (payload.length < 8) return;
        this.#block(peer, v.getUint32(0), v.getUint32(4), payload.subarray(8));
        break;
    }
    this.#fill(peer);
  }

  /** Gives back every block the peer was asked for. */
  #release(peer) {
    for (const key of peer.inflight) {
      const [piece, block] = key.split(':').map(Number);
      const a = this.active.get(piece);
      if (!a) continue;
      const by = a.by.get(block);
      by?.delete(peer);
      if (a.blocks[block] === 1 && (!by || by.size === 0)) a.blocks[block] = 0;
    }
    peer.inflight.clear();
  }

  #fill(peer) {
    if (!this.info || this.stopped || peer.wire.peerChoking || !peer.have || peer.wire.closed) return;
    const limit = peer.snubbed ? 4 : peer.maxInflight;
    // Top up only once half the requests are answered, so they leave in batches (one relay message each).
    if (peer.inflight.size > limit / 2) return;
    while (peer.inflight.size < limit) {
      const pick = this.#pick(peer);
      if (!pick) break;
      const [piece, block] = pick;
      const a = this.active.get(piece);
      a.blocks[block] = 1;
      if (!a.by.has(block)) a.by.set(block, new Set());
      a.by.get(block).add(peer);
      peer.inflight.add(`${piece}:${block}`);
      const begin = block * BLOCK;
      peer.wire.request(piece, begin, Math.min(BLOCK, this.info.pieceSize(piece) - begin));
    }
  }

  #pick(peer) {
    // 1. A free block in a piece already under way.
    for (const [piece, a] of this.active) {
      if (!peer.have[piece]) continue;
      const block = a.blocks.indexOf(0);
      if (block !== -1) return [piece, block];
    }
    // 2. A new piece the peer has, starting from a random place.
    const maxActive = Math.max(4, Math.min(Math.max(16, this.peers.size * 2), Math.floor((128 * 1024 * 1024) / this.info.pieceLength)));
    if (this.active.size < maxActive) {
      const n = this.info.pieceCount;
      const start = Math.floor(Math.random() * n);
      for (let k = 0; k < n; k++) {
        const piece = (start + k) % n;
        if (this.done[piece] || this.active.has(piece) || !peer.have[piece]) continue;
        const blocks = Math.ceil(this.info.pieceSize(piece) / BLOCK);
        this.active.set(piece, { buf: new Uint8Array(this.info.pieceSize(piece)), blocks: new Uint8Array(blocks), left: blocks, by: new Map() });
        return [piece, 0];
      }
    }
    // 3. End game: everything is requested, so ask this peer for blocks others are slow on.
    if (this.active.size && this.#allRequested()) {
      for (const [piece, a] of this.active) {
        if (!peer.have[piece]) continue;
        for (let b = 0; b < a.blocks.length; b++) {
          if (a.blocks[b] === 1 && !a.by.get(b)?.has(peer) && (a.by.get(b)?.size ?? 0) < 2) return [piece, b];
        }
      }
    }
    return null;
  }

  #allRequested() {
    return this.remaining - this.active.size - this.verifying <= 0;
  }

  #block(peer, piece, begin, data) {
    this.stats.receivedBytes += data.length;
    const block = begin / BLOCK;
    const key = `${piece}:${block}`;
    peer.inflight.delete(key);
    peer.lastBlockAt = Date.now();
    peer.snubbed = false;
    const a = this.active.get(piece);
    if (!a || !Number.isInteger(block) || block >= a.blocks.length || a.blocks[block] === 2) {
      this.stats.wastedBytes += data.length;
      return;
    }
    const expected = Math.min(BLOCK, a.buf.length - begin);
    if (data.length !== expected) {
      this.stats.wastedBytes += data.length;
      return;
    }
    a.buf.set(data, begin);
    a.blocks[block] = 2;
    a.left--;
    // Cancel duplicate end-game requests.
    for (const other of a.by.get(block) ?? []) {
      if (other !== peer && other.inflight.delete(key)) other.wire.cancel(piece, begin, expected);
    }
    a.by.delete(block);
    if (a.left === 0) this.#finishPiece(piece, a);
  }

  async #finishPiece(piece, a) {
    this.active.delete(piece);
    this.done[piece] = 2;
    this.verifying++;
    const ok = equalBytes(await sha1(a.buf), this.info.pieceHash(piece));
    if (ok && !this.stopped) {
      try {
        await this.sink.write?.(piece * this.info.pieceLength, a.buf);
      } catch (err) {
        this.verifying--;
        this.stop(`couldn't save: ${err.message}`);
        return;
      }
    }
    this.verifying--;
    if (this.stopped) return;
    if (!ok) {
      this.done[piece] = 0; // picked again later
      this.stats.hashFailures++;
      this.stats.wastedBytes += a.buf.length;
      return;
    }
    this.done[piece] = 1;
    this.remaining--;
    this.stats.verifiedBytes += a.buf.length;
    this.stats.firstPieceAt ??= Date.now();
    // No "have" messages: this client doesn't upload yet, and each one would cost a relay message.
    if (this.remaining === 0) {
      this.stats.finishedAt = Date.now();
      this.stop('complete');
    } else if (this.stats.verifiedBytes >= this.limitBytes) {
      this.stats.finishedAt = Date.now();
      this.stop('limit reached');
    }
  }
}

function splitHostPort(s) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) ?? /^([^:]+):(\d+)$/.exec(s);
  return m ? [m[1], Number(m[2])] : [null, null];
}
