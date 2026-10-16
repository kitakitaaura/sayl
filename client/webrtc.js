/**
 * Direct connections to other browsers over WebRTC, the way WebTorrent does it,
 * so Sayl can trade pieces with other Sayl tabs and with WebTorrent apps.
 *
 * Browsers find each other through WebTorrent trackers (ws:// or wss://): each
 * one announces with a few WebRTC offers, the tracker hands those offers to
 * other browsers in the swarm, and their answers come back the same way. Once
 * a data channel opens, it carries the normal BitTorrent wire protocol, just
 * like a relay tunnel. STUN servers (free) tell each side its public address;
 * there's no TURN here, so a pair that can't connect directly just doesn't.
 *
 * The other browser and the tracker see this browser's IP address, unlike the
 * relay, so Sayl only uses this when the person turns it on.
 */

/** WebTorrent's own defaults. */
export const DEFAULT_ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }];
const OFFER_TIMEOUT_MS = 50_000; // an offer nobody answered is dropped (as WebTorrent does)
const ICE_WAIT_MS = 5_000; // offers and answers carry their candidates (no trickle); wait at most this long for them
const OPEN_TIMEOUT_MS = 30_000;
const MAX_OFFERS = 5;
const CHUNK = 16 * 1024; // data channel messages every browser accepts

export const webrtcSupported = () => typeof globalThis.RTCPeerConnection === 'function' && typeof globalThis.WebSocket === 'function';

/** The trackers' "binary strings": one character per byte. */
const toBinary = (bytes) => String.fromCharCode(...bytes);
const fromBinary = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const randomBinary = () => toBinary(crypto.getRandomValues(new Uint8Array(20)));

/** Resolves once the connection has gathered its ICE candidates, or after ICE_WAIT_MS. */
function iceGathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, ICE_WAIT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/**
 * A data channel to another browser, with the same shape as a relay tunnel, so the
 * wire protocol runs over it unchanged. Small writes in one tick go out together.
 */
export class RtcTunnel {
  constructor(pc, channel) {
    this.pc = pc;
    this.channel = channel;
    this.queue = [];
    this.ondata = null;
    this.onclose = null;
    this.closed = false;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.messagesOut = 0; // relay messages: none, this doesn't go through the relay
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (e) => {
      if (typeof e.data === 'string') return;
      this.bytesIn += e.data.byteLength;
      this.ondata?.(new Uint8Array(e.data));
    };
    channel.onclose = () => this.#ended('closed');
    channel.onerror = () => this.#ended('data channel error');
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.#ended(`connection ${pc.connectionState}`);
    });
  }
  send(bytes) {
    if (this.closed || this.channel.readyState !== 'open') return;
    this.bytesOut += bytes.length;
    if (this.queue.push(bytes) === 1) queueMicrotask(() => this.#flush());
  }
  #flush() {
    const parts = this.queue.splice(0);
    if (this.closed || this.channel.readyState !== 'open') return;
    const size = parts.reduce((n, p) => n + p.length, 0);
    const all = parts.length === 1 ? parts[0] : new Uint8Array(size);
    if (parts.length > 1) {
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
    }
    try {
      for (let o = 0; o < all.length; o += CHUNK) this.channel.send(all.subarray(o, o + CHUNK));
    } catch {
      this.#ended('send failed');
    }
  }
  /** Bytes waiting to go out. */
  get buffered() {
    return this.queue.reduce((n, p) => n + p.length, 0) + (this.channel.bufferedAmount ?? 0);
  }
  close() {
    this.#ended(null);
  }
  #ended(reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.channel.close();
    } catch {}
    try {
      this.pc.close();
    } catch {}
    this.onclose?.(reason ?? 'closed');
  }
}

/**
 * One WebTorrent tracker for one torrent.
 *   stats():      { uploaded, downloaded, left }
 *   wantOffers(): how many new connections to offer now (0 when seeding: others come to us)
 *   accept():     whether to answer someone else's offer now
 *   onpeer(tunnel, peerIdHex, rank)
 *
 * Two browsers that share several trackers can end up connected more than once. `rank`
 * lets both sides keep the same one: the connection offered by the browser with the
 * smaller peer id wins, then the smallest offer id (both sides know both).
 */
export class WebRtcTracker {
  constructor(url, { infoHash, peerId, iceServers = DEFAULT_ICE_SERVERS, stats, wantOffers, accept, onpeer, log = () => {} }) {
    this.url = url;
    this.infoHash = toBinary(infoHash);
    this.peerId = toBinary(peerId);
    this.iceServers = iceServers;
    this.stats = stats;
    this.wantOffers = wantOffers;
    this.accept = accept;
    this.onpeer = onpeer;
    this.log = log;
    this.ws = null;
    this.stopped = false;
    this.started = false; // "started" sent
    this.intervalMs = 120_000;
    this.timer = null;
    this.retryMs = 15_000;
    this.offers = new Map(); // offer_id (binary) → { pc, channel, timer }
    this.answering = 0;
    this.status = 'connecting';
  }

  start() {
    this.#open();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.started) this.#send({ ...this.#base(), event: 'stopped' });
    for (const o of this.offers.values()) this.#dropOffer(o);
    this.offers.clear();
    try {
      this.ws?.close();
    } catch {}
  }

  /** Tells the tracker the download is complete (no offers: seeders wait to be asked). */
  completed() {
    if (this.started) this.#send({ ...this.#base(), event: 'completed' });
  }

  #open() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.status = `unreachable: ${err.message}`;
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 15_000;
      this.status = 'connected';
      void this.announce();
    };
    ws.onmessage = (e) => {
      let data;
      try {
        data = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
      } catch {
        return;
      }
      this.#message(data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearTimeout(this.timer);
      if (this.stopped) return;
      this.status = 'reconnecting';
      // a tracker that went away: try again, less and less often
      this.timer = setTimeout(() => this.#open(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10 * 60_000);
    };
  }

  #base() {
    const s = this.stats();
    return { action: 'announce', info_hash: this.infoHash, peer_id: this.peerId, uploaded: s.uploaded, downloaded: s.downloaded, left: s.left };
  }

  #send(params) {
    if (this.ws?.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(params));
      return true;
    } catch {
      return false;
    }
  }

  /** Announces with fresh offers, then again at the tracker's pace. */
  async announce() {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const n = Math.max(0, Math.min(MAX_OFFERS, this.wantOffers()));
    const offers = n ? await this.#makeOffers(n) : [];
    if (this.stopped) return offers.forEach((o) => this.#dropOffer(this.offers.get(o.offer_id)));
    const params = { ...this.#base(), numwant: offers.length, offers };
    if (!this.started) params.event = 'started';
    if (this.#send(params)) this.started = true;
    this.timer = setTimeout(() => void this.announce(), this.intervalMs);
  }

  async #makeOffers(n) {
    const out = [];
    await Promise.all(
      Array.from({ length: n }, async () => {
        let pc;
        try {
          pc = new RTCPeerConnection({ iceServers: this.iceServers });
          const channel = pc.createDataChannel(hexOf(crypto.getRandomValues(new Uint8Array(10))));
          await pc.setLocalDescription(await pc.createOffer());
          await iceGathered(pc);
          const offerId = randomBinary();
          const timer = setTimeout(() => {
            const o = this.offers.get(offerId);
            if (o) this.#dropOffer(o);
            this.offers.delete(offerId);
          }, OFFER_TIMEOUT_MS);
          this.offers.set(offerId, { pc, channel, timer });
          out.push({ offer: { type: 'offer', sdp: pc.localDescription.sdp }, offer_id: offerId });
        } catch (err) {
          this.log(`couldn't make a WebRTC offer: ${err.message}`);
          try {
            pc?.close();
          } catch {}
        }
      }),
    );
    return out;
  }

  #dropOffer(o) {
    if (!o) return;
    clearTimeout(o.timer);
    try {
      o.pc.close();
    } catch {}
  }

  #message(data) {
    if (data.info_hash !== this.infoHash) return;
    if (data['failure reason']) {
      this.status = `refused: ${data['failure reason']}`;
      return;
    }
    if (Number.isFinite(data.interval) && data.interval > 0) this.intervalMs = Math.min(Math.max(data.interval * 1000, 60_000), 10 * 60_000);
    if (typeof data.peer_id !== 'string' || data.peer_id.length !== 20 || data.peer_id === this.peerId) return;
    if (data.offer && data.offer_id) void this.#answer(data);
    else if (data.answer && data.offer_id) void this.#answered(data);
  }

  /** Someone answered one of our offers. */
  async #answered(data) {
    const o = this.offers.get(data.offer_id);
    if (!o) return;
    this.offers.delete(data.offer_id);
    clearTimeout(o.timer);
    try {
      await o.pc.setRemoteDescription(data.answer);
    } catch (err) {
      this.log(`a WebRTC answer didn't work: ${err.message}`);
      return this.#dropOffer(o);
    }
    this.#whenOpen(o.pc, o.channel, data.peer_id, this.peerId, data.offer_id);
  }

  /** Someone else's offer, passed on by the tracker: answer it if there's room. */
  async #answer(data) {
    if (this.stopped || this.answering >= MAX_OFFERS || !this.accept()) return;
    this.answering++;
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: this.iceServers });
      const gotChannel = new Promise((resolve) => (pc.ondatachannel = (e) => resolve(e.channel)));
      await pc.setRemoteDescription(data.offer);
      await pc.setLocalDescription(await pc.createAnswer());
      await iceGathered(pc);
      if (this.stopped) return pc.close();
      this.#send({ ...this.#base(), to_peer_id: data.peer_id, answer: { type: 'answer', sdp: pc.localDescription.sdp }, offer_id: data.offer_id });
      let timer;
      const channel = await Promise.race([gotChannel, new Promise((resolve) => (timer = setTimeout(() => resolve(null), OPEN_TIMEOUT_MS)))]);
      clearTimeout(timer);
      if (!channel) return pc.close();
      this.#whenOpen(pc, channel, data.peer_id, data.peer_id, data.offer_id);
    } catch (err) {
      this.log(`couldn't answer a WebRTC offer: ${err.message}`);
      try {
        pc?.close();
      } catch {}
    } finally {
      this.answering--;
    }
  }

  #whenOpen(pc, channel, peerId, offererId, offerId) {
    const ready = () => {
      clearTimeout(timer);
      if (this.stopped) return pc.close();
      const smaller = this.peerId < peerId ? this.peerId : peerId;
      const rank = `${offererId === smaller ? 0 : 1}${hexOf(fromBinary(offerId))}`;
      this.onpeer(new RtcTunnel(pc, channel), hexOf(fromBinary(peerId)), rank);
    };
    const timer = setTimeout(() => pc.close(), OPEN_TIMEOUT_MS);
    if (channel.readyState === 'open') ready();
    else channel.addEventListener('open', ready, { once: true });
  }
}
