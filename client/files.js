/**
 * Mapping between pieces and files. A torrent is one long stream of bytes cut
 * into pieces; the files sit end to end in it, so a piece can span several.
 */

/** The file parts a piece covers: [{ file, fileOffset, pieceOffset, length }]. */
export function pieceSegments(info, piece) {
  const start = piece * info.pieceLength;
  const end = start + info.pieceSize(piece);
  const out = [];
  for (let i = firstFileAt(info, start); i < info.files.length; i++) {
    const f = info.files[i];
    if (f.offset >= end) break;
    const from = Math.max(start, f.offset);
    const to = Math.min(end, f.offset + f.length);
    if (to > from) out.push({ file: i, fileOffset: from - f.offset, pieceOffset: from - start, length: to - from });
  }
  return out;
}

function firstFileAt(info, byte) {
  let lo = 0;
  let hi = info.files.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (info.files[mid].offset <= byte) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** The pieces needed for these files (1 = needed). */
export function piecesForFiles(info, fileIndexes) {
  const wanted = new Uint8Array(info.pieceCount);
  for (const i of fileIndexes) {
    const f = info.files[i];
    if (!f || f.length === 0) continue;
    const first = Math.floor(f.offset / info.pieceLength);
    const last = Math.floor((f.offset + f.length - 1) / info.pieceLength);
    wanted.fill(1, first, last + 1);
  }
  return wanted;
}

/** Bytes of each file covered by verified pieces. */
export function fileProgress(info, have) {
  const done = new Array(info.files.length).fill(0);
  for (let p = 0; p < info.pieceCount; p++) {
    if (!have[p]) continue;
    for (const s of pieceSegments(info, p)) done[s.file] += s.length;
  }
  return done;
}

/**
 * A file's path as safe name parts: no empty, "." or ".." parts, no slashes
 * or control characters. Torrents come from strangers.
 */
export function safePathParts(path) {
  const parts = String(path)
    .split(/[\\/]+/)
    .map((p) => p.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim())
    .filter((p) => p && p !== '.' && p !== '..')
    .map((p) => (p.length > 200 ? p.slice(0, 200) : p));
  return parts.length ? parts : ['file'];
}
