/**
 * Downloads one torrent from the swarm through the relay. Runs in the browser
 * or in Node 22+ (it only needs WebSocket and crypto.subtle).
 *
 *   const d = new Download({ relay, source, sink });
 *   d.onprogress = (stats) => …;
 *   await d.start();          // resolves when done (or stopped)
 *
 * source:     { infoHash (hex), trackers, peers: ['host:port'], info? }
 * sink:       { open(info), write(offset, bytes, piece), close() } — writes may arrive in any order
 * dht:        { getTurn: async () => [{ url, username, credential }], bootstrap? } — optional
 * wanted:     'all', or a Uint8Array with 1 for each piece to download, or null to
 *             wait (peers stay connected) until select() is called — e.g. while
 *             the user picks files once the metadata is in
 * have:       a Uint8Array with 1 for pieces already verified on disk (resuming)
 * sequential: fetch pieces in order instead of rarest-first-ish random order
 * seed:       share too: answer peers' requests for the pieces we have, and once
 *             everything wanted is in, keep going (seeding) until stop() is called
 * read:       async (piece) => the piece's bytes from storage, needed with `seed`
 * limits:     { download?, upload? } — RateLimiters (limiter.js), shared by every download for a
 *             page-wide speed limit
 * webrtc:     { trackers: ['wss://…'], iceServers?, maxPeers? } — also connect straight to
 *             other browsers (WebTorrent's way), found through these trackers and the
 *             torrent's own ws(s):// ones. Browser only. Peers then see this browser's IP.
 *
 * Callbacks: onmetadata(info) once the info dict is known, onpiece(piece)
 * after each verified piece is written, oncomplete() once every wanted piece
 * is in, onprogress(stats) every second.
 *
 * Finding peers, in order: the torrent's own trackers and the public HTTP
 * trackers (right away), then PEX from connected peers, and only if all of
 * that leaves us with nobody to talk to, a DHT lookup through TURN. If the
 * DHT is unavailable (not set up, quota used up, server down) the download
 * carries on with what it has.
 *
 * Seeding: relays can't take incoming connections, so a seeder connects out to
 * the peers trackers and PEX name, and uploads to those that ask. Up to
 * `uploadSlots` interested peers are unchoked at once, taking turns every 30 s.
 */
import { MSG, EXT, Wire, parseMetadataMessage, parsePex } from './wire.js';
import { announce, announceUrls } from './tracker.js';
import { loadPublicTrackers } from './public-trackers.js';
import { openTunnel } from './tunnel.js';
import { equalBytes, fromHex, hex, parseInfo, sha1 } from './torrent.js';
import { TurnClient, TurnError, parseTurnUrl } from './turn.js';
import { Dht, resolveBootstrap } from './dht.js';
import { WebRtcTracker, webrtcSupported } from './webrtc.js';
import { countDoSecond } from './usage.js';

const BLOCK = 16 * 1024;
const METADATA_PIECE = 16 * 1024;
const MAX_METADATA = 16 * 1024 * 1024;
const SNUB_MS = 20_000;
const MAX_ANNOUNCING = 12;
const DHT_AFTER_MS = 15_000; // give trackers and PEX this long before trying the DHT
const DHT_RETRY_MS = 10 * 60_000;
const SEED_ANNOUNCE_S = 300; // a seeder asks the torrent's first trackers for new peers every 5 minutes
const SEED_FAST_TRACKERS = 10; // as many as a magnet link carries
const MAX_REQUEST = 128 * 1024; // the biggest block a peer may ask us for
const MAX_QUEUED_REQUESTS = 500; // per peer: what our extension handshake promises (reqq), so none are dropped
const MAX_BUFFERED = 4 * 1024 * 1024; // per peer: past this, wait for the relay to catch up
const ROTATE_MS = 30_000;
/** Shared by every download on the page: when the DHT failed in a way that won't fix itself soon. */
let dhtOffUntil = 0;

export class Download {
  constructor({
    relay,
    source,
    sink,
    maxPeers = 40,
    pipeline = 64,
    limitBytes = Infinity,
    extraTrackers = true,
    dht = null,
    wanted = 'all',
    have = null,
    sequential = false,
    seed = false,
    read = null,
    uploadSlots = 4,
    webrtc = null,
    limits = {},
    log = () => {},
  }) {
    this.relay = relay;
    this.source = source;
    this.sink = sink;
    this.maxPeers = maxPeers;
    this.pipeline = pipeline;
    this.limitBytes = limitBytes;
    this.log = log;
    this.wanted = null; // Uint8Array per piece once known
    this.wantedOption = wanted;
    this.haveOption = have;
    this.sequential = sequential;
    this.seed = seed && typeof read === 'function';
    this.readPiece = read;
    this.uploadSlots = Math.max(1, uploadSlots);
    /** true once everything wanted is in and the download stays up to share */
    this.seeding = false;
    this.unchoked = new Set();
    this.lastRotateAt = 0;
    this.pieceCache = new Map(); // piece → Promise<Uint8Array | null>, oldest first
    this.webrtcOptions = webrtc && webrtcSupported() ? webrtc : null;
    this.limits = limits ?? {};
    this.throttleTimer = null;
    this.rtcTrackers = [];
    this.rtc = new Map(); // peer id (hex) → { rank, close }: browsers connected over WebRTC
    this.infoHash = fromHex(source.infoHash);
    this.peerId = new TextEncoder().encode(`-SY0001-${Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join('')}`);
    this.extraTrackers = extraTrackers;
    this.dhtOptions = dht;
    this.trackers = new Map(); // url → { nextAt, failures, busy }
    this.announcing = 0;
    this.dhtRunning = false;
    this.dhtNextAt = 0;
    this.info = null;
    this.known = new Map(); // "host:port" → { host, port, from, tried, live, nextAt, fails, drops, done }
    this.peers = new Set();
    this.connecting = 0;
    this.stats = {
      started: 0,
      metadataAt: null,
      firstPieceAt: null,
      finishedAt: null,
      verifiedBytes: 0,
      receivedBytes: 0,
      uploadedBytes: 0,
      webrtcPeers: 0,
      wastedBytes: 0,
      hashFailures: 0,
      messagesOut: 0,
      found: 0,
      tried: 0,
      connected: 0,
      handshaken: 0,
      failures: {},
      trackers: {},
      dht: dht ? 'not needed' : 'off',
      dhtLookups: 0,
    };
    this.metadata = null; // { size, pieces: [], got }
    this.active = new Map(); // piece → { buf, blocks: Uint8Array (0 free, 1 requested, 2 received), left, by: Map(block → Set(peer)) }
    this.done = null; // Uint8Array per piece: 0 = missing, 1 = verified, 2 = being verified
    this.verifying = 0;
    this.remaining = 0;
    this.stopped = false;
    this.onprogress = null;
    this.onmetadata = null;
    this.onpiece = null;
    this.oncomplete = null;
  }

  /** Verified pieces (1) so far, or null before the metadata is known. */
  get have() {
    return this.done ? this.done.map((v) => (v === 1 ? 1 : 0)) : null;
  }

  /** Chooses the pieces to download (1 = download); starts the download if it was waiting. */
  select(wanted) {
    if (!this.info) throw new Error('the metadata is not known yet');
    if (!(wanted instanceof Uint8Array) || wanted.length !== this.info.pieceCount) throw new Error('wanted must have one entry per piece');
    this.wanted = wanted;
    this.#recount();
    if (this.remaining === 0) this.#complete();
    else for (const peer of this.peers) this.#fill(peer);
  }

  set sequentialMode(on) {
    this.sequential = !!on;
  }

  /** Fetches these pieces (inclusive) before any others, e.g. where a video is playing. */
  prioritize(from, to) {
    this.priority = [from, to];
    if (!this.stopped) for (const peer of this.peers) this.#fill(peer);
  }

  #recount() {
    let n = 0;
    if (this.wanted) for (let i = 0; i < this.info.pieceCount; i++) if (this.wanted[i] && this.done[i] !== 1) n++;
    this.remaining = n;
  }

  #complete() {
    if (this.seeding) return;
    this.stats.finishedAt ??= Date.now();
    this.oncomplete?.();
    if (!this.seed) return this.stop('complete');
    this.seeding = true;
    this.log('complete; seeding');
    for (const t of this.trackers.values()) if (t.announced) t.completedPending = true;
    for (const t of this.rtcTrackers) t.completed();
    for (const peer of this.peers) {
      if (this.#isSeed(peer)) peer.wire.close('both seeds');
      else peer.wire.notInterested();
    }
  }

  /** A peer with every piece: nothing to trade once we're seeding too. */
  #isSeed(peer) {
    return !!this.info && !!peer.have && peer.haveCount === this.info.pieceCount;
  }

  async start() {
    this.stats.started = Date.now();
    this.finished = new Promise((resolve) => (this.#resolve = resolve));
    if (this.source.info) await this.#setInfo(this.source.info);
    for (const p of this.source.peers ?? []) this.#addPeer(p, 'given');
    this.#addTrackers(this.source.trackers ?? [], SEED_FAST_TRACKERS);
    if (this.extraTrackers) loadPublicTrackers().then((list) => this.#addTrackers(list));
    this.#announceDue();
    this.#startWebRtc();
    this.ticker = setInterval(() => this.#tick(), 1000);
    return this.finished;
  }

  #resolve = () => {};

  stop(reason = 'stopped') {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    clearInterval(this.ticker);
    for (const t of this.rtcTrackers) t.stop();
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
      complete: this.remaining === 0 && !!this.info && !!this.wanted,
      stopReason: this.stopReason ?? null,
      metadataSeconds: s.metadataAt ? (s.metadataAt - s.started) / 1000 : null,
      firstPieceSeconds: s.firstPieceAt ? (s.firstPieceAt - s.started) / 1000 : null,
      verifiedBytes: s.verifiedBytes,
      receivedBytes: s.receivedBytes,
      uploadedBytes: s.uploadedBytes,
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
      dht: s.dht,
      webrtcPeers: s.webrtcPeers,
      peersFrom: [...this.known.values()].reduce((o, k) => ((o[k.from] = (o[k.from] ?? 0) + 1), o), {}),
    };
  }

  // ── peers ───────────────────────────────────────────────────────────────

  #addPeer(p, from) {
    const [host, port] = typeof p === 'string' ? splitHostPort(p) : [p.host, p.port];
    if (!host || !port) return;
    const key = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
    const k = this.known.get(key);
    if (k) {
      // A tracker naming a peer we gave up on: worth another go.
      if (from === 'tracker' && !k.live && !k.done && k.nextAt === Infinity) {
        k.fails = 0;
        k.nextAt = 0;
      }
      return;
    }
    this.known.set(key, { host, port, from, tried: false, live: false, nextAt: 0, fails: 0, drops: 0, done: false });
    this.stats.found++;
  }

  /**
   * When to try a peer again. Peers can't reach a relay, so reconnecting is up to us: a peer that
   * dropped us (a client restarting a torrent, say) is retried after 15 s, then less often; one we
   * couldn't reach, twice more; a fellow seed, never.
   */
  #retryLater(k, { failed = false, reason = '', since = 0 } = {}) {
    k.live = false;
    const now = Date.now();
    if (reason === 'both seeds') {
      k.done = true;
      k.nextAt = Infinity;
    } else if (failed) {
      k.fails++;
      k.nextAt = k.fails >= 3 ? Infinity : now + 60_000 * k.fails;
    } else {
      k.fails = 0;
      if (since && now - since > 5 * 60_000) k.drops = 0; // a long, healthy connection
      k.drops++;
      k.nextAt = now + 15_000 * 2 ** Math.min(k.drops - 1, 5);
    }
  }

  /** `fast`: how many of these a seeder asks every 5 minutes (the rest at the tracker's own pace). */
  #addTrackers(urls, fast = 0) {
    announceUrls(urls).forEach((url, i) => {
      if (!this.trackers.has(url)) this.trackers.set(url, { nextAt: 0, failures: 0, busy: false, fast: i < fast });
    });
    this.#announceDue();
  }

  /** Announces to the trackers that are due, a few at a time, each on its own schedule. */
  #announceDue() {
    if (this.stopped) return;
    const now = Date.now();
    for (const [url, t] of this.trackers) {
      if (this.announcing >= MAX_ANNOUNCING) break;
      if (t.busy || t.nextAt > now) continue;
      t.busy = true;
      this.announcing++;
      const left = this.seeding ? 0 : this.info ? this.remaining * this.info.pieceLength : 1;
      const event = !t.announced ? 'started' : t.completedPending ? 'completed' : undefined;
      announce(this.relay, url, { infoHash: this.infoHash, peerId: this.peerId, left, downloaded: this.stats.verifiedBytes, uploaded: this.stats.uploadedBytes, event })
        .then((r) => {
          t.announced = true;
          if (event === 'completed') t.completedPending = false;
          t.failures = 0;
          this.stats.trackers[url] = `${r.peers.length} peers`;
          for (const p of r.peers) this.#addPeer(p, 'tracker');
          // Ask again at the tracker's own pace, between 5 and 30 minutes. A seeder can't be
          // reached, so it asks the torrent's own first trackers every 5 minutes, to find new peers.
          t.nextAt = Date.now() + (this.seeding && t.fast ? SEED_ANNOUNCE_S : Math.min(Math.max(r.interval, 300), 1800)) * 1000;
        })
        .catch((err) => {
          t.failures++;
          this.stats.trackers[url] = `failed: ${err.message}`;
          t.nextAt = t.failures >= 2 ? Infinity : Date.now() + 10 * 60_000;
        })
        .finally(() => {
          t.busy = false;
          this.announcing--;
          this.#announceDue();
        });
    }
  }

  /** The last resort: only when trackers and PEX have left us with no one to connect to. */
  #maybeDht(now) {
    // a seeder finds peers through trackers and PEX only, to spare the TURN quota
    if (!this.dhtOptions || this.seeding || this.dhtRunning || now < this.dhtNextAt) return;
    const waited = now - this.stats.started;
    // Wait for the trackers' answers, but not forever: a slow tracker shouldn't hold the DHT back.
    if (waited < DHT_AFTER_MS || (this.announcing > 0 && waited < 45_000)) return;
    if (this.peers.size > 0 || this.connecting > 0) return;
    for (const k of this.known.values()) if (!k.tried) return;
    if (now < dhtOffUntil) {
      this.stats.dht = 'off for now (an earlier lookup failed)';
      return;
    }
    this.#runDht();
  }

  async #runDht() {
    this.dhtRunning = true;
    this.stats.dhtLookups++;
    this.stats.dht = 'looking up';
    this.log('no peers from trackers, asking the DHT');
    let turn = null;
    try {
      const servers = await this.dhtOptions.getTurn();
      if (!servers?.length) throw new TurnError('no TURN server is set up', 'off');
      let stream = null;
      let server = null;
      for (const s of servers) {
        const target = parseTurnUrl(s.url);
        if (!target) continue;
        try {
          stream = await openTunnel(this.relay, target);
          server = s;
          break;
        } catch {}
      }
      if (!stream) throw new TurnError("couldn't reach the TURN server");
      turn = await TurnClient.connect(stream, { username: server.username, password: server.credential });
      const dht = new Dht(turn);
      const bootstrap = this.dhtOptions.bootstrap ?? (await resolveBootstrap());
      const r = await dht.getPeers(this.infoHash, bootstrap, { enough: 60 });
      for (const p of r.peers) this.#addPeer(p, 'dht');
      this.stats.dht = `found ${r.peers.length} peers`;
      this.log(`the DHT found ${r.peers.length} peers`);
    } catch (err) {
      this.stats.dht = `unavailable: ${err.message}`;
      this.log(`the DHT is unavailable (${err.message}); carrying on without it`);
      // Out of quota, refused, or not set up: don't keep trying for an hour.
      if (err instanceof TurnError && [401, 403, 486, 508, 'off', 'quota'].includes(err.code)) dhtOffUntil = Date.now() + 60 * 60_000;
    } finally {
      turn?.close();
      this.dhtRunning = false;
      this.dhtNextAt = Date.now() + DHT_RETRY_MS;
    }
  }

  #tick() {
    if (this.stopped) return;
    const now = Date.now();
    // its Durable Object is busy (and billed for time) while any connection to it is open
    if (this.relay.via === 'do' && (this.peers.size > 0 || this.connecting > 0 || this.announcing > 0)) countDoSecond();
    this.#announceDue();
    this.#maybeDht(now);
    // Open more connections, a few at a time.
    let budget = 10;
    for (const [key, k] of this.known) {
      if (budget <= 0 || this.peers.size + this.connecting >= this.maxPeers) break;
      if (k.live || k.nextAt > now) continue;
      k.tried = true;
      k.live = true;
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
      if (peer.requests.length) void this.#serve(peer);
    }
    if (this.seed) this.#rotate(now);
    this.onprogress?.(this.progress());
  }

  progress() {
    const s = this.stats;
    const secs = (Date.now() - (this.lastProgressAt ?? s.started)) / 1000;
    const rate = secs > 0 ? (s.verifiedBytes - (this.lastVerified ?? 0)) / secs : 0;
    const upRate = secs > 0 ? (s.uploadedBytes - (this.lastUploaded ?? 0)) / secs : 0;
    this.lastProgressAt = Date.now();
    this.lastVerified = s.verifiedBytes;
    this.lastUploaded = s.uploadedBytes;
    let unchoked = 0;
    let seeds = 0;
    for (const p of this.peers) {
      if (!p.wire.peerChoking) unchoked++;
      if (this.info && p.haveCount === this.info.pieceCount) seeds++;
    }
    return {
      name: this.info?.name ?? null,
      size: this.info?.length ?? null,
      verifiedBytes: s.verifiedBytes,
      bytesPerSecond: rate,
      uploadedBytes: s.uploadedBytes,
      uploadBytesPerSecond: upRate,
      seeding: this.seeding,
      peersKnown: this.known.size,
      peersConnected: this.peers.size,
      peersUnchoked: unchoked,
      seeds,
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
      this.#retryLater(k, { failed: true });
      return;
    }
    if (this.stopped) {
      this.connecting--;
      k.live = false;
      return tunnel.close();
    }
    this.#startWire(tunnel, key, k);
  }

  // ── WebRTC: straight to other browsers ──────────────────────────────────

  #startWebRtc() {
    const o = this.webrtcOptions;
    if (!o) return;
    const max = o.maxPeers ?? 10;
    const own = (this.source.trackers ?? []).filter((t) => /^wss?:\/\//i.test(t));
    const urls = [...new Set([...(o.trackers ?? []), ...own])];
    const rtcCount = () => this.rtc.size;
    this.rtcTrackers = urls.map(
      (url) =>
        new WebRtcTracker(url, {
          infoHash: this.infoHash,
          peerId: this.peerId,
          iceServers: o.iceServers,
          stats: () => ({ uploaded: this.stats.uploadedBytes, downloaded: this.stats.verifiedBytes, left: this.seeding ? 0 : this.info ? this.remaining * this.info.pieceLength : 1 }),
          // a seeder makes no offers: browsers that need pieces offer to it
          wantOffers: () => (this.seeding || this.stopped ? 0 : Math.min(5, max - rtcCount())),
          accept: () => !this.stopped && rtcCount() < max,
          onpeer: (tunnel, id, rank) => {
            // connected twice (through two trackers): both sides keep the better-ranked one
            const current = this.rtc.get(id);
            if (current && rank >= current.rank) return tunnel.close();
            if (this.stopped || (!current && rtcCount() >= max)) return tunnel.close();
            current?.close();
            const entry = { rank, close: () => tunnel.close() };
            this.rtc.set(id, entry);
            this.stats.webrtcPeers++;
            this.connecting++;
            this.#startWire(tunnel, `webrtc:${id}`, null, () => this.rtc.get(id) === entry && this.rtc.delete(id));
          },
          log: this.log,
        }),
    );
    for (const t of this.rtcTrackers) t.start();
  }

  /** Runs the wire protocol over an open tunnel (relay or WebRTC). The caller counted it in `connecting`. */
  #startWire(tunnel, key, k, ended = null) {
    let connectedAt = 0;
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
      haveCount: 0,
      pendingBitfield: null,
      pendingHaves: [],
      lastBlockAt: Date.now(),
      lastUnchokedAt: Date.now(),
      snubbed: false,
      maxInflight: this.pipeline,
      wantsMetadata: false,
      requests: [], // what the peer asked us for: { index, begin, length }
      serving: false,
      unchokedAt: 0,
      rtc: !k,
    };
    const wireOptions = {
      infoHash: this.infoHash,
      peerId: this.peerId,
      bitfield: () => this.#bitfield(),
      metadataSize: () => (this.seed && this.info?.raw ? this.info.raw.length : null),
    };
    peer.wire = new Wire(tunnel, wireOptions, {
      onHandshake: () => {
        settle();
        connectedAt = Date.now();
        this.stats.handshaken++;
        this.peers.add(peer);
        this.#applyHaves(peer); // a peer with nothing to offer may never send a bitfield
        if (!this.seeding) peer.wire.interested();
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
        if (k) this.#retryLater(k, { failed: !connectedAt, reason, since: connectedAt });
        ended?.();
        this.stats.messagesOut += tunnel.messagesOut;
        this.peers.delete(peer);
        this.#release(peer);
        peer.requests = [];
        if (this.unchoked.delete(peer)) this.#unchokeSome();
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
    if (id !== EXT.ut_metadata) return;
    let m;
    try {
      m = parseMetadataMessage(body);
    } catch {
      return;
    }
    if (m.type === 0) return this.#serveMetadata(peer, m.piece);
    if (this.info || !this.metadata) return;
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

  /** A peer asked for a piece of the info dict (only offered when seeding). */
  #serveMetadata(peer, piece) {
    const raw = this.seed ? this.info?.raw : null;
    const count = raw ? Math.ceil(raw.length / METADATA_PIECE) : 0;
    if (!raw || !Number.isInteger(piece) || piece < 0 || piece >= count) return peer.wire.sendMetadata(piece, 0, null);
    peer.wire.sendMetadata(piece, raw.length, raw.subarray(piece * METADATA_PIECE, (piece + 1) * METADATA_PIECE));
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
    const have = this.haveOption;
    if (have) for (let i = 0; i < info.pieceCount; i++) if (have[i]) this.done[i] = 1;
    const w = this.wantedOption;
    if (w === 'all') this.wanted = new Uint8Array(info.pieceCount).fill(1);
    else if (w instanceof Uint8Array && w.length === info.pieceCount) this.wanted = w;
    else this.wanted = null;
    this.#recount();
    this.stats.metadataAt = Date.now();
    this.log(`metadata: ${info.name}, ${info.files.length} file(s), ${(info.length / 1e6).toFixed(1)} MB, ${info.pieceCount} pieces of ${info.pieceLength / 1024} KiB`);
    try {
      await this.sink.open?.(info);
    } catch (err) {
      this.stop(`couldn't save: ${err.message}`);
      return;
    }
    for (const peer of this.peers) this.#applyHaves(peer);
    this.onmetadata?.(info);
    if (this.wanted && this.remaining === 0) this.#complete();
  }

  #applyHaves(peer) {
    if (!this.info || peer.have) return;
    peer.have = new Uint8Array(this.info.pieceCount);
    if (peer.pendingBitfield) {
      const bf = peer.pendingBitfield;
      for (let i = 0; i < this.info.pieceCount; i++) if (bf[i >> 3] & (0x80 >> (i & 7))) peer.have[i] = 1;
    }
    for (const i of peer.pendingHaves) if (i < this.info.pieceCount) peer.have[i] = 1;
    peer.haveCount = peer.have.reduce((n, v) => n + v, 0);
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
        if (this.seeding && this.#isSeed(peer)) return peer.wire.close('both seeds');
        break;
      case MSG.have: {
        if (payload.length < 4) return;
        const i = v.getUint32(0);
        if (peer.have) {
          if (i < peer.have.length && !peer.have[i]) {
            peer.have[i] = 1;
            peer.haveCount++;
          }
          if (this.seeding && this.#isSeed(peer)) return peer.wire.close('both seeds');
        } else peer.pendingHaves.push(i);
        break;
      }
      case MSG.interested:
        this.#unchokeSome();
        break;
      case MSG.notInterested:
        if (this.unchoked.delete(peer)) {
          peer.wire.choke();
          peer.requests = [];
          this.#unchokeSome();
        }
        break;
      case MSG.request:
        if (payload.length < 12) return;
        this.#request(peer, v.getUint32(0), v.getUint32(4), v.getUint32(8));
        break;
      case MSG.cancel: {
        if (payload.length < 12) return;
        const [index, begin, length] = [v.getUint32(0), v.getUint32(4), v.getUint32(8)];
        peer.requests = peer.requests.filter((r) => !(r.index === index && r.begin === begin && r.length === length));
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
    if (!this.info || !this.wanted || this.stopped || peer.wire.peerChoking || !peer.have || peer.wire.closed) return;
    const limit = peer.snubbed ? 4 : peer.maxInflight;
    // Top up only once half the requests are answered, so they leave in batches (one relay message each).
    if (peer.inflight.size > limit / 2) return;
    while (peer.inflight.size < limit) {
      const pick = this.#pick(peer);
      if (!pick) break;
      const [piece, block] = pick;
      const a = this.active.get(piece);
      const size = Math.min(BLOCK, this.info.pieceSize(piece) - block * BLOCK);
      // the download speed limit: ask for no more than it allows; try again shortly
      if (this.limits.download && !this.limits.download.take(size)) {
        if (a.left === a.blocks.length && a.blocks.every((b) => b === 0)) this.active.delete(piece); // picked just now, unasked
        this.#throttled();
        break;
      }
      a.blocks[block] = 1;
      if (!a.by.has(block)) a.by.set(block, new Set());
      a.by.get(block).add(peer);
      peer.inflight.add(`${piece}:${block}`);
      const begin = block * BLOCK;
      peer.wire.request(piece, begin, Math.min(BLOCK, this.info.pieceSize(piece) - begin));
    }
  }

  /** Throttled by the speed limit: fill every peer again in a moment. */
  #throttled() {
    this.throttleTimer ??= setTimeout(() => {
      this.throttleTimer = null;
      if (!this.stopped) for (const peer of this.peers) this.#fill(peer);
    }, 100);
  }

  #pick(peer) {
    // 1. A free block in a piece already under way.
    for (const [piece, a] of this.active) {
      if (!peer.have[piece]) continue;
      const block = a.blocks.indexOf(0);
      if (block !== -1) return [piece, block];
    }
    // 2. A wanted piece in the priority range (where something is playing), whatever is under way.
    if (this.priority) {
      const [from, to] = this.priority;
      for (let piece = Math.max(0, from); piece <= Math.min(to, this.info.pieceCount - 1); piece++) {
        if (!this.wanted[piece] || this.done[piece] || this.active.has(piece) || !peer.have[piece]) continue;
        const blocks = Math.ceil(this.info.pieceSize(piece) / BLOCK);
        this.active.set(piece, { buf: new Uint8Array(this.info.pieceSize(piece)), blocks: new Uint8Array(blocks), left: blocks, by: new Map() });
        return [piece, 0];
      }
    }
    // 3. A new wanted piece the peer has: the first one in sequential mode, else from a random place.
    const maxActive = Math.max(4, Math.min(Math.max(16, this.peers.size * 2), Math.floor((128 * 1024 * 1024) / this.info.pieceLength)));
    if (this.active.size < maxActive) {
      const n = this.info.pieceCount;
      const start = this.sequential ? 0 : Math.floor(Math.random() * n);
      for (let k = 0; k < n; k++) {
        const piece = (start + k) % n;
        if (!this.wanted[piece] || this.done[piece] || this.active.has(piece) || !peer.have[piece]) continue;
        const blocks = Math.ceil(this.info.pieceSize(piece) / BLOCK);
        this.active.set(piece, { buf: new Uint8Array(this.info.pieceSize(piece)), blocks: new Uint8Array(blocks), left: blocks, by: new Map() });
        return [piece, 0];
      }
    }
    // 4. End game: everything is requested, so ask this peer for blocks others are slow on.
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
        await this.sink.write?.(piece * this.info.pieceLength, a.buf, piece);
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
    if (this.wanted?.[piece]) this.remaining--; // select() may have dropped it while it was being fetched
    this.stats.verifiedBytes += a.buf.length;
    this.stats.firstPieceAt ??= Date.now();
    this.onpiece?.(piece);
    // Only when sharing: each "have" costs a relay message.
    if (this.seed) {
      for (const peer of this.peers) peer.wire.have(piece);
      this.#cachePiece(piece, Promise.resolve(a.buf));
    }
    if (this.remaining === 0) {
      this.#complete();
    } else if (this.stats.verifiedBytes >= this.limitBytes) {
      this.stats.finishedAt = Date.now();
      this.stop('limit reached');
    }
  }

  // ── uploading ───────────────────────────────────────────────────────────

  /** Our verified pieces, packed one bit per piece; null when not sharing or when we have none. */
  #bitfield() {
    if (!this.seed || !this.done) return null;
    const bits = new Uint8Array(Math.ceil(this.done.length / 8));
    let any = false;
    for (let i = 0; i < this.done.length; i++) {
      if (this.done[i] !== 1) continue;
      bits[i >> 3] |= 0x80 >> (i & 7);
      any = true;
    }
    return any ? bits : null;
  }

  /** Unchokes interested peers until the upload slots are full, picking at random. `skip` waits a turn. */
  #unchokeSome(skip = null) {
    if (!this.seed || this.stopped) return;
    for (const p of this.unchoked) {
      if (p.wire.closed || !p.wire.peerInterested) {
        this.unchoked.delete(p);
        if (!p.wire.closed) p.wire.choke();
        p.requests = [];
      }
    }
    const waiting = [...this.peers].filter((p) => p !== skip && p.wire.peerInterested && p.wire.amChoking && !p.wire.closed);
    while (this.unchoked.size < this.uploadSlots && waiting.length) {
      const p = waiting.splice(Math.floor(Math.random() * waiting.length), 1)[0];
      p.wire.unchoke();
      p.unchokedAt = Date.now();
      this.unchoked.add(p);
    }
  }

  /** Every 30 s, if others are waiting, the peer unchoked longest makes room, so everyone gets a turn. */
  #rotate(now) {
    if (now - this.lastRotateAt < ROTATE_MS) return;
    this.lastRotateAt = now;
    const someoneWaits = [...this.peers].some((p) => p.wire.peerInterested && p.wire.amChoking);
    if (!someoneWaits || this.unchoked.size < this.uploadSlots) return this.#unchokeSome();
    let oldest = null;
    for (const p of this.unchoked) if (!oldest || p.unchokedAt < oldest.unchokedAt) oldest = p;
    if (now - oldest.unchokedAt < ROTATE_MS) return;
    oldest.wire.choke();
    oldest.requests = []; // a choke drops what was asked
    this.unchoked.delete(oldest);
    this.#unchokeSome(oldest);
  }

  #request(peer, index, begin, length) {
    if (!this.seed || peer.wire.amChoking || !this.info) return;
    if (index >= this.info.pieceCount || this.done[index] !== 1) return;
    if (length === 0 || length > MAX_REQUEST || begin + length > this.info.pieceSize(index)) return;
    if (peer.requests.length >= MAX_QUEUED_REQUESTS) return;
    peer.requests.push({ index, begin, length });
    void this.#serve(peer);
  }

  /** Answers a peer's requests, a piece at a time; all blocks of one piece leave together. */
  async #serve(peer) {
    if (peer.serving) return;
    peer.serving = true;
    try {
      while (peer.requests.length && !peer.wire.closed && !peer.wire.amChoking && !this.stopped) {
        // A slow peer: let the relay catch up first (the next tick tries again).
        if (peer.wire.tunnel.buffered > MAX_BUFFERED) break;
        const index = peer.requests[0].index;
        const data = await this.#pieceData(index);
        const now = peer.requests.filter((r) => r.index === index);
        peer.requests = peer.requests.filter((r) => r.index !== index);
        if (!data || peer.wire.closed || peer.wire.amChoking || this.stopped) continue;
        const up = this.limits.upload;
        for (const r of now) {
          // the upload speed limit: blocks within it leave together; past it, one at a time as it allows
          if (up && !up.take(r.length)) await up.wait(r.length);
          if (peer.wire.closed || peer.wire.amChoking || this.stopped) break;
          peer.wire.piece(r.index, r.begin, data.subarray(r.begin, r.begin + r.length));
          this.stats.uploadedBytes += r.length;
        }
      }
    } finally {
      peer.serving = false;
    }
  }

  /** A verified piece's bytes, read back from storage (and checked) or from the cache. */
  #pieceData(index) {
    const hit = this.pieceCache.get(index);
    if (hit) {
      this.pieceCache.delete(index);
      this.pieceCache.set(index, hit);
      return hit;
    }
    const p = (async () => {
      const bytes = await this.readPiece(index);
      if (!bytes || bytes.length !== this.info.pieceSize(index) || !equalBytes(await sha1(bytes), this.info.pieceHash(index))) {
        this.log(`piece ${index} didn't read back intact; not sharing it`);
        this.pieceCache.delete(index);
        return null;
      }
      return bytes;
    })().catch(() => {
      this.pieceCache.delete(index);
      return null;
    });
    this.#cachePiece(index, p);
    return p;
  }

  /** Keeps a few recent pieces (up to 64 MiB) in memory: peers tend to ask for a piece's blocks together. */
  #cachePiece(index, promise) {
    this.pieceCache.delete(index);
    this.pieceCache.set(index, promise);
    const max = Math.max(2, Math.min(8, Math.floor((64 * 1024 * 1024) / this.info.pieceLength)));
    while (this.pieceCache.size > max) this.pieceCache.delete(this.pieceCache.keys().next().value);
  }
}

function splitHostPort(s) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) ?? /^([^:]+):(\d+)$/.exec(s);
  return m ? [m[1], Number(m[2])] : [null, null];
}
