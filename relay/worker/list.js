/**
 * The torrent list, shared by every device that uses this relay (with its token), so a torrent
 * added on one shows up on the others. Stored in this account's own Durable Object storage.
 *
 *   GET  /list[?token=…]             → { entries }
 *   POST /list[?token=…]  { entries } → { entries }, merged
 *
 * An entry: { hash, name, trackers, addedAt, updatedAt, removed }. Each device sends what it has;
 * per torrent, the newer `updatedAt` wins, so devices never overwrite each other's changes.
 * A removal stays as a marker (`removed`) for 30 days, so devices that were away hear of it.
 */

const MAX_ENTRIES = 2000;
const MAX_BODY = 1024 * 1024;
const KEEP_REMOVED_MS = 30 * 24 * 3600_000;
/** The Durable Object that holds the list: a name tunnel sessions can't take (they can't contain ':'). */
export const LIST_OBJECT = 'sayl:list';

function clean(e) {
  if (!e || typeof e !== 'object' || typeof e.hash !== 'string' || !/^[0-9a-f]{40}$/.test(e.hash)) return null;
  const time = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
  const updatedAt = time(e.updatedAt);
  if (!updatedAt) return null;
  return {
    hash: e.hash,
    name: typeof e.name === 'string' ? e.name.slice(0, 300) : e.hash,
    trackers: Array.isArray(e.trackers) ? e.trackers.filter((t) => typeof t === 'string' && t.length <= 500).slice(0, 30) : [],
    addedAt: time(e.addedAt) ?? updatedAt,
    updatedAt,
    removed: e.removed === true,
  };
}

/** In the Durable Object: answer a list request against its storage. */
export async function handleList(request, storage) {
  const json = (body, status = 200) => Response.json(body, { status });
  if (request.method === 'POST') {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'too big' }, 413);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'bad json' }, 400);
    }
    const incoming = (Array.isArray(body?.entries) ? body.entries : []).map(clean).filter(Boolean).slice(0, MAX_ENTRIES);
    // storage takes at most 128 keys per call
    for (let i = 0; i < incoming.length; i += 128) {
      const batch = incoming.slice(i, i + 128);
      const stored = await storage.get(batch.map((e) => `t:${e.hash}`));
      const writes = {};
      for (const e of batch) {
        const have = stored.get(`t:${e.hash}`);
        if (!have || e.updatedAt > have.updatedAt) writes[`t:${e.hash}`] = e;
      }
      if (Object.keys(writes).length) await storage.put(writes);
    }
  } else if (request.method !== 'GET') {
    return json({ error: 'GET or POST' }, 405);
  }
  const all = await storage.list({ prefix: 't:' });
  const now = Date.now();
  const entries = [];
  const expired = [];
  for (const [key, e] of all) {
    if (e.removed && now - e.updatedAt > KEEP_REMOVED_MS) expired.push(key);
    else entries.push(e);
  }
  for (let i = 0; i < expired.length; i += 128) await storage.delete(expired.slice(i, i + 128));
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return json({ entries: entries.slice(0, MAX_ENTRIES) });
}
