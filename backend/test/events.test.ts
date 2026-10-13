import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TorrentView } from '../src/engine.js';
import { harness, hashOf, ORIGIN, type Harness } from './harness.js';

let h: Harness;
let base: string;
beforeEach(async () => {
  h = await harness();
  await h.api.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(h.api.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await h.close();
});

/** Opens the event stream and collects `torrents` events. */
async function stream(cookie: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { cookie, origin: ORIGIN }, signal: ctrl.signal });
  const events: TorrentView[][] = [];
  const reader = res.body!.getReader();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^event: torrents\ndata: (.*)$/m.exec(block);
          if (data) events.push(JSON.parse(data[1]!) as TorrentView[]);
        }
      }
    } catch {
      // aborted
    }
  })();
  const waitFor = async (n: number) => {
    for (let t = 0; t < 100 && events.length < n; t++) await new Promise((r) => setTimeout(r, 20));
    return events;
  };
  return { res, events, waitFor, close: async () => (ctrl.abort(), await pump) };
}

describe('live updates', () => {
  it('streams only the caller’s torrents, with CORS headers for the frontend', async () => {
    const alice = await h.user();
    const bob = await h.user();
    const a = await stream(alice.cookie);
    const b = await stream(bob.cookie);
    expect(a.res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(a.res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(a.res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(await a.waitFor(1)).toEqual([[]]);

    await alice.addMagnet(hashOf(0x66), 'live');
    const events = await a.waitFor(2);
    expect(events[1]!.map((t) => t.hash)).toEqual([hashOf(0x66)]);

    await h.tick();
    // bob's stream only ever saw his own (empty) list
    expect(b.events).toEqual([[]]);
    await a.close();
    await b.close();
  });

  it('refuses the stream without a session', async () => {
    const res = await fetch(`${base}/api/events`);
    expect(res.status).toBe(401);
  });
});
