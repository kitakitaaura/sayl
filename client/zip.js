/**
 * Builds a .zip of files as one Blob made from the files themselves, stored without
 * compression, so even many gigabytes stay on disk: the browser reads the files
 * only when the zip is saved. Making it reads each file once, for its CRC-32.
 * ZIP64 records are written for files of 4 GB or more and for big archives.
 *
 *   const zip = await makeZip([{ path: 'show/ep1.mkv', blob }], { onprogress, signal });
 *
 * onprogress(readBytes, totalBytes); signal aborts. Paths use "/" between folders.
 */

const LIMIT = 0xffffffff; // the most a 32-bit zip field holds; at or past it, ZIP64 takes over
const CHUNK = 8 * 1024 * 1024;

let table = null;
function crcTable() {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** Continues a CRC-32 (start with 0) over more bytes. */
export function crc32(bytes, crc = 0) {
  const t = crcTable();
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class Writer {
  constructor(size) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
    this.o = 0;
  }
  u16(v) {
    this.view.setUint16(this.o, v, true);
    this.o += 2;
  }
  u32(v) {
    this.view.setUint32(this.o, v >>> 0, true);
    this.o += 4;
  }
  u64(v) {
    this.view.setBigUint64(this.o, BigInt(v), true);
    this.o += 8;
  }
  raw(b) {
    this.bytes.set(b, this.o);
    this.o += b.length;
  }
}

/**
 * files: [{ path, blob }]. Returns a Blob of type application/zip.
 * forceZip64 (for tests): write ZIP64 records even for small files.
 */
export async function makeZip(files, { onprogress, signal, now = new Date(), forceZip64 = false } = {}) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const total = files.reduce((n, f) => n + f.blob.size, 0);
  const parts = [];
  const entries = [];
  let offset = 0;
  let read = 0;
  for (const f of files) {
    const name = enc.encode(f.path.replace(/^\/+/, ''));
    if (!name.length) throw new Error('a file has no name');
    // CRC-32: read the file once, a chunk at a time
    let crc = 0;
    for (let pos = 0; pos < f.blob.size; pos += CHUNK) {
      if (signal?.aborted) throw signal.reason ?? new Error('cancelled');
      const chunk = new Uint8Array(await f.blob.slice(pos, Math.min(pos + CHUNK, f.blob.size)).arrayBuffer());
      crc = crc32(chunk, crc);
      read += chunk.length;
      onprogress?.(read, total);
    }
    const size = f.blob.size;
    const big = forceZip64 || size >= LIMIT;
    // local header: with ZIP64, both sizes move into the extra field
    const local = new Writer(30 + name.length + (big ? 20 : 0));
    local.u32(0x04034b50);
    local.u16(big ? 45 : 20);
    local.u16(0x0800); // names are UTF-8
    local.u16(0); // stored
    local.u16(time);
    local.u16(date);
    local.u32(crc);
    local.u32(big ? LIMIT : size);
    local.u32(big ? LIMIT : size);
    local.u16(name.length);
    local.u16(big ? 20 : 0);
    local.raw(name);
    if (big) {
      local.u16(0x0001);
      local.u16(16);
      local.u64(size);
      local.u64(size);
    }
    parts.push(local.bytes, f.blob);
    entries.push({ name, crc, size, big, offset });
    offset += local.bytes.length + size;
  }

  // central directory
  const cdStart = offset;
  for (const e of entries) {
    const farOffset = forceZip64 || e.offset >= LIMIT;
    const extraLen = (e.big ? 16 : 0) + (farOffset ? 8 : 0);
    const c = new Writer(46 + e.name.length + (extraLen ? 4 + extraLen : 0));
    c.u32(0x02014b50);
    c.u16(45); // made by: zip 4.5
    c.u16(e.big || farOffset ? 45 : 20);
    c.u16(0x0800);
    c.u16(0);
    c.u16(time);
    c.u16(date);
    c.u32(e.crc);
    c.u32(e.big ? LIMIT : e.size);
    c.u32(e.big ? LIMIT : e.size);
    c.u16(e.name.length);
    c.u16(extraLen ? 4 + extraLen : 0);
    c.u16(0); // comment
    c.u16(0); // disk
    c.u16(0); // internal attributes
    c.u32(0); // external attributes
    c.u32(farOffset ? LIMIT : e.offset);
    c.raw(e.name);
    if (extraLen) {
      c.u16(0x0001);
      c.u16(extraLen);
      if (e.big) {
        c.u64(e.size);
        c.u64(e.size);
      }
      if (farOffset) c.u64(e.offset);
    }
    parts.push(c.bytes);
    offset += c.bytes.length;
  }
  const cdSize = offset - cdStart;

  const zip64End = forceZip64 || entries.length >= 0xffff || cdStart >= LIMIT || cdSize >= LIMIT || entries.some((e) => e.big || e.offset >= LIMIT);
  if (zip64End) {
    const z = new Writer(56 + 20);
    z.u32(0x06064b50);
    z.u64(44); // size of the rest of this record
    z.u16(45);
    z.u16(45);
    z.u32(0);
    z.u32(0);
    z.u64(entries.length);
    z.u64(entries.length);
    z.u64(cdSize);
    z.u64(cdStart);
    // locator
    z.u32(0x07064b50);
    z.u32(0);
    z.u64(offset);
    z.u32(1);
    parts.push(z.bytes);
  }
  const end = new Writer(22);
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(zip64End ? 0xffff : entries.length);
  end.u16(zip64End ? 0xffff : entries.length);
  end.u32(zip64End ? LIMIT : cdSize);
  end.u32(zip64End ? LIMIT : cdStart);
  end.u16(0);
  parts.push(end.bytes);
  return new Blob(parts, { type: 'application/zip' });
}
