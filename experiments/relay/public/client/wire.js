/**
 * The BitTorrent peer wire protocol (BEP 3) with the extension protocol
 * (BEP 10), ut_metadata (BEP 9) and ut_pex (BEP 11), over a relay tunnel.
 * Download only: we never unchoke anyone in this experiment.
 */
import { BencodeError, concat, decode, encode } from './bencode.js';

const PROTOCOL = new TextEncoder().encode('BitTorrent protocol');
export const MSG = { choke: 0, unchoke: 1, interested: 2, notInterested: 3, have: 4, bitfield: 5, request: 6, piece: 7, cancel: 8, port: 9, extended: 20 };
/** Our ids for the extension messages we understand. */
export const EXT = { ut_metadata: 1, ut_pex: 2 };
const MAX_MESSAGE = 1024 * 1024 + 64;

export class Wire {
  /** handlers: onHandshake, onExtHandshake, onMessage(id, payload), onClose(reason) */
  constructor(tunnel, { infoHash, peerId }, handlers) {
    this.tunnel = tunnel;
    this.infoHash = infoHash;
    this.h = handlers;
    this.buf = new Uint8Array(0);
    this.handshaken = false;
    this.closed = false;
    this.peerChoking = true;
    this.ext = null; // their extension handshake
    tunnel.ondata = (b) => this.#receive(b);
    tunnel.onclose = (reason) => this.close(reason || 'closed');

    const reserved = new Uint8Array(8);
    reserved[5] |= 0x10; // extension protocol
    this.tunnel.send(concat([new Uint8Array([19]), PROTOCOL, reserved, infoHash, peerId]));
    this.keepAlive = setInterval(() => this.tunnel.send(new Uint8Array(4)), 60_000);
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.tunnel.close();
    this.h.onClose?.(reason);
  }

  #receive(bytes) {
    if (this.closed) return;
    this.buf = this.buf.length ? concat([this.buf, bytes]) : bytes;
    try {
      if (!this.handshaken) {
        if (this.buf.length < 68) return;
        const b = this.buf;
        if (b[0] !== 19 || new TextDecoder().decode(b.subarray(1, 20)) !== 'BitTorrent protocol') throw new Error('bad handshake');
        if (!b.subarray(28, 48).every((x, i) => x === this.infoHash[i])) throw new Error('peer has a different torrent');
        this.supportsExt = (b[25] & 0x10) !== 0;
        this.remoteId = b.slice(48, 68);
        this.handshaken = true;
        this.buf = b.subarray(68);
        if (this.supportsExt) {
          this.sendExtended(0, encode({ m: { ut_metadata: EXT.ut_metadata, ut_pex: EXT.ut_pex }, v: 'Sayl relay 0.1', reqq: 500 }));
        }
        this.h.onHandshake?.();
      }
      let offset = 0;
      for (;;) {
        if (this.buf.length - offset < 4) break;
        const view = new DataView(this.buf.buffer, this.buf.byteOffset + offset);
        const len = view.getUint32(0);
        if (len > MAX_MESSAGE) throw new Error('message too large');
        if (this.buf.length - offset < 4 + len) break;
        const msg = this.buf.subarray(offset + 4, offset + 4 + len);
        offset += 4 + len;
        if (len > 0) this.#message(msg[0], msg.subarray(1));
        if (this.closed) return;
      }
      // Keep the unread tail in its own buffer so finished messages can be freed.
      this.buf = offset ? this.buf.slice(offset) : this.buf;
    } catch (err) {
      this.close(err instanceof BencodeError ? `bad bencode: ${err.message}` : err.message);
    }
  }

  #message(id, payload) {
    if (id === MSG.choke) this.peerChoking = true;
    else if (id === MSG.unchoke) this.peerChoking = false;
    if (id === MSG.extended) {
      const extId = payload[0];
      const body = payload.subarray(1);
      if (extId === 0) {
        this.ext = decode(body).value;
        this.h.onExtHandshake?.(this.ext);
        return;
      }
      this.h.onExtended?.(extId, body);
      return;
    }
    this.h.onMessage?.(id, payload);
  }

  send(id, payload = new Uint8Array(0)) {
    const out = new Uint8Array(5 + payload.length);
    new DataView(out.buffer).setUint32(0, 1 + payload.length);
    out[4] = id;
    out.set(payload, 5);
    this.tunnel.send(out);
  }

  sendExtended(extId, body) {
    this.send(MSG.extended, concat([new Uint8Array([extId]), body]));
  }

  interested() {
    this.send(MSG.interested);
  }

  request(index, begin, length) {
    const p = new Uint8Array(12);
    const v = new DataView(p.buffer);
    v.setUint32(0, index);
    v.setUint32(4, begin);
    v.setUint32(8, length);
    this.send(MSG.request, p);
  }

  cancel(index, begin, length) {
    const p = new Uint8Array(12);
    const v = new DataView(p.buffer);
    v.setUint32(0, index);
    v.setUint32(4, begin);
    v.setUint32(8, length);
    this.send(MSG.cancel, p);
  }

  have(index) {
    const p = new Uint8Array(4);
    new DataView(p.buffer).setUint32(0, index);
    this.send(MSG.have, p);
  }

  /** Asks for one 16 KiB piece of the info dict, if the peer offers ut_metadata. */
  requestMetadata(piece) {
    const theirId = this.ext?.m?.ut_metadata;
    if (!theirId) return false;
    this.sendExtended(theirId, encode({ msg_type: 0, piece }));
    return true;
  }
}

/** Parses a ut_metadata message: { type, piece, totalSize, data }. */
export function parseMetadataMessage(body) {
  const { value, end } = decode(body);
  return { type: value.msg_type, piece: value.piece, totalSize: value.total_size, data: body.subarray(end) };
}

/** Parses a ut_pex message into [{host, port}] (IPv4 and IPv6 "added" lists). */
export function parsePex(body) {
  const { value } = decode(body);
  const out = [];
  const a = value.added;
  if (a instanceof Uint8Array) {
    for (let i = 0; i + 6 <= a.length; i += 6) out.push({ host: `${a[i]}.${a[i + 1]}.${a[i + 2]}.${a[i + 3]}`, port: (a[i + 4] << 8) | a[i + 5] });
  }
  const a6 = value.added6;
  if (a6 instanceof Uint8Array) {
    for (let i = 0; i + 18 <= a6.length; i += 18) {
      const groups = [];
      for (let g = 0; g < 8; g++) groups.push(((a6[i + g * 2] << 8) | a6[i + g * 2 + 1]).toString(16));
      out.push({ host: groups.join(':'), port: (a6[i + 16] << 8) | a6[i + 17] });
    }
  }
  return out.filter((p) => p.port > 0);
}
