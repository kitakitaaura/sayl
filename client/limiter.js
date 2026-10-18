/**
 * A speed limit: a token bucket of bytes, refilled at `bytesPerSecond`, holding at most one
 * second's worth (or 64 KiB), so a pause doesn't turn into a burst. One limiter can be shared by
 * every download on the page for a limit that covers them all. 0 = no limit.
 */
export class RateLimiter {
  constructor(bytesPerSecond = 0) {
    this.setRate(bytesPerSecond);
  }

  setRate(bytesPerSecond) {
    this.rate = bytesPerSecond > 0 ? bytesPerSecond : 0;
    this.tokens = this.#burst();
    this.last = Date.now();
  }

  #burst() {
    return Math.max(this.rate, 64 * 1024);
  }

  #refill() {
    const now = Date.now();
    this.tokens = Math.min(this.#burst(), this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  /** Takes n bytes if they may go now; always true without a limit. */
  take(n) {
    if (!this.rate) return true;
    this.#refill();
    if (this.tokens < Math.min(n, this.#burst())) return false;
    this.tokens -= n;
    return true;
  }

  /** Waits until n bytes may go, and takes them. */
  async wait(n) {
    while (!this.take(n)) {
      const short = Math.min(n, this.#burst()) - this.tokens;
      await new Promise((r) => setTimeout(r, Math.max(10, Math.min(1000, (short / (this.rate || 1)) * 1000))));
    }
  }
}
