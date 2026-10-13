/**
 * Anonymous sessions: a random id in a signed, httpOnly cookie. Nothing about
 * the visitor is stored server side. The owner id written to qBittorrent tags
 * and the database is a hash of the session id, so neither reveals the cookie.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { unauthorized } from './errors.js';

export const COOKIE_NAME = 'sayl_sid';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export const newSessionId = () => randomBytes(18).toString('base64url');
export const ownerIdFor = (sessionId: string) => createHash('sha256').update(sessionId).digest('base64url').slice(0, 22);

export function cookieOptions(cfg: Config) {
  const secure = new URL(cfg.FRONTEND_ORIGIN).protocol === 'https:';
  return { path: '/', httpOnly: true, secure, sameSite: 'lax' as const, signed: true, maxAge: MAX_AGE_SECONDS };
}

/** The verified session id from the cookie, or null. */
export function readSession(req: FastifyRequest): string | null {
  const raw = req.cookies[COOKIE_NAME];
  if (!raw) return null;
  const r = req.unsignCookie(raw);
  if (!r.valid || !r.value || !/^[A-Za-z0-9_-]{24}$/.test(r.value)) return null;
  return r.value;
}

export function startSession(reply: FastifyReply, cfg: Config): string {
  const id = newSessionId();
  reply.setCookie(COOKIE_NAME, id, cookieOptions(cfg));
  return id;
}

export function endSession(reply: FastifyReply, cfg: Config): void {
  const { maxAge: _maxAge, signed: _signed, ...opts } = cookieOptions(cfg);
  reply.clearCookie(COOKIE_NAME, opts);
}

/** The owner id for this request, or a 401. */
export function requireOwner(req: FastifyRequest): string {
  const id = readSession(req);
  if (!id) throw unauthorized();
  return ownerIdFor(id);
}
