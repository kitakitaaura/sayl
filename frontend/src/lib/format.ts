import type { Limits } from './api';

/** Decimal units, like disk sizes: 1 GB = 1,000,000,000 bytes. */
export function fmtBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) {
    b /= 1000;
    i++;
  }
  const n = i === 0 ? Math.round(b) : b < 10 ? b.toFixed(2) : b < 100 ? b.toFixed(1) : Math.round(b);
  return `${n} ${u[i]}`;
}

export const fmtSpeed = (b: number) => `${fmtBytes(b)}/s`;

export function fmtDur(seconds: number): string {
  const sec = Math.max(0, Math.round(seconds));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Hours finished files are kept for a selection of this size, or null if it's over every tier. */
export function keepHours(bytes: number, limits: Limits | null): number | null {
  if (!limits) return null;
  const tier = limits.retention.find((t) => bytes <= t.maxGb * 1e9);
  return tier ? tier.hours : null;
}
