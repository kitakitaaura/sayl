/**
 * What a visitor needs before getting a session: the beta access code
 * (ACCESS_CODE) and a Cloudflare Turnstile check (TURNSTILE_SECRET_KEY).
 * Either is off when its setting is empty.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';

export type CaptchaVerifier = (token: string, ip: string) => Promise<boolean>;

export function codeMatches(expected: string, given: string): boolean {
  // hash both so the comparison takes the same time whatever the lengths
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(given).digest();
  return timingSafeEqual(a, b);
}

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Asks Cloudflare whether a Turnstile token is valid. Fails closed. */
export function turnstileVerifier(cfg: Config): CaptchaVerifier {
  return async (token, ip) => {
    if (!token || token.length > 2048) return false;
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      body: new URLSearchParams({ secret: cfg.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`turnstile answered ${res.status}`);
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  };
}

export function accessRequirements(cfg: Config) {
  return { code: cfg.ACCESS_CODE !== '', captcha: cfg.TURNSTILE_SECRET_KEY !== '' };
}
