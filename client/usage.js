/**
 * What this page has cost the relay, counted as it goes, so the site can show how close it is to
 * Cloudflare's free daily allowance. Estimates for this page only: other devices or tabs using the
 * same relay aren't counted here.
 *
 *   workerRequests  every request to the relay Worker: each tunnel, /health, /turn-credentials, /list
 *   doRequests      Durable Object requests: each tunnel through a Durable Object, plus one per
 *                   20 WebSocket messages sent into it (how Cloudflare bills them)
 *   doSeconds       seconds a download kept its Durable Object busy (they're billed for time, too)
 */
export const relayUsage = { workerRequests: 0, doRequests: 0, doSeconds: 0 };

let doMessages = 0;

/** One request to the relay Worker (and to a Durable Object, when it goes through one). */
export function countRequest({ durableObject = false } = {}) {
  relayUsage.workerRequests++;
  if (durableObject) relayUsage.doRequests++;
}

/** WebSocket messages sent into a Durable Object: every 20 count as one request. */
export function countDoMessages(n) {
  doMessages += n;
  const whole = Math.floor(doMessages / 20);
  if (whole) {
    relayUsage.doRequests += whole;
    doMessages -= whole * 20;
  }
}

/** A second of a Durable Object being busy. */
export function countDoSecond() {
  relayUsage.doSeconds++;
}
