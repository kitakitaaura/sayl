/**
 * Bencode (BitTorrent's serialisation format) decoder and encoder.
 * Strings stay as Buffers because torrent fields like `pieces` are binary.
 */

export type BValue = number | Buffer | BValue[] | BDict;
export interface BDict {
  [key: string]: BValue;
}

export class BencodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BencodeError';
  }
}

const MAX_DEPTH = 64;

/**
 * Decodes one bencoded value. `infoSpan` receives the byte range of the
 * top-level "info" dictionary so its hash can be computed over the exact bytes.
 */
export function decode(buf: Buffer, infoSpan?: { start: number; end: number }): BValue {
  let pos = 0;

  const fail = (msg: string): never => {
    throw new BencodeError(`${msg} at byte ${pos}`);
  };

  const readInt = (end: number): number => {
    const s = buf.toString('latin1', pos, end);
    if (!/^(0|-?[1-9][0-9]*)$/.test(s)) fail('bad integer');
    const n = Number(s);
    if (!Number.isSafeInteger(n)) fail('integer too large');
    pos = end;
    return n;
  };

  const value = (depth: number, isTopInfo = false): BValue => {
    if (depth > MAX_DEPTH) fail('nesting too deep');
    if (pos >= buf.length) fail('unexpected end');
    const c = buf[pos]!;
    if (c === 0x69 /* i */) {
      pos++;
      const end = buf.indexOf(0x65 /* e */, pos);
      if (end === -1) fail('unterminated integer');
      const n = readInt(end);
      pos++;
      return n;
    }
    if (c === 0x6c /* l */) {
      pos++;
      const list: BValue[] = [];
      while (buf[pos] !== 0x65) {
        if (pos >= buf.length) fail('unterminated list');
        list.push(value(depth + 1));
      }
      pos++;
      return list;
    }
    if (c === 0x64 /* d */) {
      const start = pos;
      pos++;
      const dict: BDict = Object.create(null) as BDict;
      while (buf[pos] !== 0x65) {
        if (pos >= buf.length) fail('unterminated dictionary');
        const key = str().toString('utf8');
        const topInfo = depth === 0 && key === 'info';
        dict[key] = value(depth + 1, topInfo);
      }
      pos++;
      if (isTopInfo && infoSpan) {
        infoSpan.start = start;
        infoSpan.end = pos;
      }
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) return str();
    return fail('unexpected byte');
  };

  const str = (): Buffer => {
    const colon = buf.indexOf(0x3a /* : */, pos);
    if (colon === -1) fail('bad string length');
    const len = readInt(colon);
    if (len < 0) fail('negative string length');
    pos++;
    if (pos + len > buf.length) fail('string past end of data');
    const out = buf.subarray(pos, pos + len);
    pos += len;
    return out;
  };

  const out = value(0);
  if (pos !== buf.length) fail('trailing data');
  return out;
}

export function encode(v: BValue): Buffer {
  const parts: Buffer[] = [];
  const walk = (x: BValue): void => {
    if (typeof x === 'number') {
      if (!Number.isSafeInteger(x)) throw new BencodeError('only integers can be encoded');
      parts.push(Buffer.from(`i${x}e`));
    } else if (Buffer.isBuffer(x)) {
      parts.push(Buffer.from(`${x.length}:`), x);
    } else if (Array.isArray(x)) {
      parts.push(Buffer.from('l'));
      x.forEach(walk);
      parts.push(Buffer.from('e'));
    } else {
      parts.push(Buffer.from('d'));
      for (const key of Object.keys(x).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
        const k = Buffer.from(key);
        parts.push(Buffer.from(`${k.length}:`), k);
        walk(x[key]!);
      }
      parts.push(Buffer.from('e'));
    }
  };
  walk(v);
  return Buffer.concat(parts);
}
