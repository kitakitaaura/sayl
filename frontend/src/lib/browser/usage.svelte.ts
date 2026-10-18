/**
 * Today's relay use from this browser, against Cloudflare's free daily allowance (which resets at
 * 00:00 UTC). The client counts as it goes (client/usage.js); this adds it up per day, across tabs.
 * Estimates, for this browser only: other devices on the same relay add to the real total.
 */
import { browser } from '$app/environment';
import { relayUsage } from '$bt';

const KEY = 'sayl.usage';

/** Cloudflare's free plan, per day: Worker requests, Durable Object requests, and Durable Object time
 * (13,000 GB-s at 128 MB each, about 28 hours of one busy object). */
export const FREE = { workerRequests: 100_000, doRequests: 100_000, doSeconds: Math.floor(13_000 / 0.128) };

type Counts = { workerRequests: number; doRequests: number; doSeconds: number };
const zero = (): Counts => ({ workerRequests: 0, doRequests: 0, doSeconds: 0 });
const utcDay = () => new Date().toISOString().slice(0, 10);

class Usage {
  today = $state<Counts>(zero());
  private day = '';
  private seen: Counts = zero();
  private started = false;

  start(): void {
    if (!browser || this.started) return;
    this.started = true;
    this.seen = { ...relayUsage };
    this.tick();
    setInterval(() => this.tick(), 5000);
    window.addEventListener('pagehide', () => this.tick());
  }

  /** Adds what's been counted since the last tick to today's stored total. */
  tick(): void {
    const day = utcDay();
    let stored: { day?: string } & Partial<Counts> = {};
    try {
      stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    } catch {
      stored = {};
    }
    const base: Counts = stored.day === day ? { workerRequests: stored.workerRequests ?? 0, doRequests: stored.doRequests ?? 0, doSeconds: stored.doSeconds ?? 0 } : zero();
    const now = { ...relayUsage };
    const next: Counts = {
      workerRequests: base.workerRequests + (now.workerRequests - this.seen.workerRequests),
      doRequests: base.doRequests + (now.doRequests - this.seen.doRequests),
      doSeconds: base.doSeconds + (now.doSeconds - this.seen.doSeconds),
    };
    this.seen = now;
    this.day = day;
    this.today = next;
    try {
      localStorage.setItem(KEY, JSON.stringify({ day, ...next }));
    } catch {
      // storage blocked: the meter just covers this visit
    }
  }

  /** The largest share of any of the three allowances used today, 0..1+. */
  get highest(): number {
    const t = this.today;
    return Math.max(t.workerRequests / FREE.workerRequests, t.doRequests / FREE.doRequests, t.doSeconds / FREE.doSeconds);
  }

  /** Seconds until the allowance resets (00:00 UTC). */
  get resetsIn(): number {
    const now = new Date();
    return (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000;
  }
}

export const usage = new Usage();
