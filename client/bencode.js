/**
 * Bencode for the browser and Node. Byte strings decode to Uint8Array, dict
 * keys to strings, integers to numbers.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export class BencodeError extends Error {}

/**
 * Decodes one value starting at `start`. Returns { value, end } where `end` is
 * the offset just past it, and `ranges` holding the raw byte range of every
 * top-level dict entry (used to hash the "info" dict exactly as it was sent).
 */
export function decode(buf, start = 0) {
  const ranges = {};
  let pos = start;

  const int = (stop) => {
    const s = stop === -1 ? -1 : buf.indexOf(stop, pos);
    if (s === -1) throw new BencodeError('unterminated integer');
    const text = dec.decode(buf.subarray(pos, s));
    if (!/^-?\d+$/.test(text)) throw new BencodeError('bad integer');
    pos = s + 1;
    return Number(text);
  };

  const value = (depth) => {
    if (depth > 64) throw new BencodeError('too deeply nested');
    const c = buf[pos];
    if (c === undefined) throw new BencodeError('unexpected end');
    if (c === 0x69) {
      pos++;
      return int(0x65);
    }
    if (c >= 0x30 && c <= 0x39) {
      const len = int(0x3a);
      if (len < 0 || pos + len > buf.length) throw new BencodeError('string runs past the end');
      const out = buf.subarray(pos, pos + len);
      pos += len;
      return out;
    }
    if (c === 0x6c) {
      pos++;
      const list = [];
      while (buf[pos] !== 0x65) list.push(value(depth + 1));
      pos++;
      return list;
    }
    if (c === 0x64) {
      pos++;
      const dict = {};
      while (buf[pos] !== 0x65) {
        const key = value(depth + 1);
        if (!(key instanceof Uint8Array)) throw new BencodeError('dict key is not a string');
        const name = dec.decode(key);
        const from = pos;
        dict[name] = value(depth + 1);
        if (depth === 0) ranges[name] = [from, pos];
      }
      pos++;
      return dict;
    }
    throw new BencodeError(`unexpected byte ${c}`);
  };

  const v = value(0);
  return { value: v, end: pos, ranges };
}

export function encode(v) {
  const parts = [];
  const walk = (x) => {
    if (typeof x === 'number') {
      if (!Number.isInteger(x)) throw new BencodeError('only integers can be encoded');
      parts.push(enc.encode(`i${x}e`));
    } else if (typeof x === 'string') {
      const b = enc.encode(x);
      parts.push(enc.encode(`${b.length}:`), b);
    } else if (x instanceof Uint8Array) {
      parts.push(enc.encode(`${x.length}:`), x);
    } else if (Array.isArray(x)) {
      parts.push(enc.encode('l'));
      x.forEach(walk);
      parts.push(enc.encode('e'));
    } else if (x && typeof x === 'object') {
      parts.push(enc.encode('d'));
      for (const k of Object.keys(x).sort()) {
        if (x[k] === undefined) continue;
        walk(k);
        walk(x[k]);
      }
      parts.push(enc.encode('e'));
    } else {
      throw new BencodeError(`can't encode ${typeof x}`);
    }
  };
  walk(v);
  return concat(parts);
}

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const text = (v) => (v instanceof Uint8Array ? dec.decode(v) : undefined);
