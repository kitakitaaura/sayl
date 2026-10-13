/**
 * Small in-memory rate limiter: fixed windows per key. It lives in the single
 * backend process, so nothing needs to be shared between servers.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a hit. Returns 0 when allowed, or the seconds to wait. */
  hit(key: string): number {
    const now = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    if (this.hits.size > 50_000) this.prune(now);
    return entry.count > this.limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  private prune(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

/** Counts open connections per key (live-update streams). */
export class ConnectionCounter {
  private open = new Map<string, number>();

  constructor(private readonly max: number) {}

  /** Takes a slot, or returns null when the key is at its limit. Call the returned function to give it back. */
  take(key: string): (() => void) | null {
    const n = this.open.get(key) ?? 0;
    if (n >= this.max) return null;
    this.open.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.open.get(key) ?? 1) - 1;
      if (left <= 0) this.open.delete(key);
      else this.open.set(key, left);
    };
  }
}
