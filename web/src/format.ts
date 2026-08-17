/** Dollar price in [0,1] → cents string, e.g. 0.155 → "15.5¢". */
export const fmtCents = (p: number | undefined, dp = 1): string =>
  p === undefined || Number.isNaN(p) ? '—' : `${(p * 100).toFixed(dp)}¢`;

/** Bare cents number without the unit (for bid/ask cells whose header carries ¢). */
export const fmtCentsBare = (p: number | undefined, dp = 1): string =>
  p === undefined || Number.isNaN(p) ? '—' : (p * 100).toFixed(dp);

/** Signed cents, e.g. +12.6¢ / −3.1¢ (proper minus sign). */
export const fmtSignedCents = (p: number | undefined, dp = 1): string => {
  if (p === undefined || Number.isNaN(p)) return '—';
  const v = p * 100;
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toFixed(dp)}¢`;
};

export const fmtInt = (n: number | undefined): string =>
  n === undefined ? '—' : n.toLocaleString('en-US');

export const fmtClock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour12: false });

export const fmtTimeShort = (t: number): string =>
  new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

export const fmtAgo = (iso: string, nowMs: number): string => {
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s ago`;
};
