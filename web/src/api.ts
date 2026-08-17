/**
 * Typed client for the Crossbook server API.
 * Source of truth: server/src/routes/api.ts and server/src/analysis/pairs.ts.
 */

export interface ArbLeg {
  venue: 'polymarket' | 'kalshi';
  side: 'YES' | 'NO';
  price: number;
  fee: number;
}

/**
 * Strategy A: buy YES on Polymarket + buy NO on Kalshi — pays when Kalshi
 * prices the outcome higher. Strategy B is the reverse. Each edge is
 * 1 − Σ(price + fee) per contract set.
 */
export interface ArbQuote {
  edgeA?: number;
  edgeB?: number;
  legsA?: ArbLeg[];
  legsB?: ArbLeg[];
  best?: 'A' | 'B';
  bestEdge?: number;
  /** Complete sets fillable at top-of-book for the best strategy (enriched). */
  executableSets?: number;
}

export interface PairQuote {
  id: string; // "<pmSlug>__<kalshiTicker>"
  pm: {
    slug: string;
    title: string;
    eventSlug: string;
    eventTitle: string;
    yesBid?: number;
    yesAsk?: number;
    mid?: number;
    feeCoefficient?: number;
  };
  kalshi: {
    ticker: string;
    outcome: string;
    eventTicker: string;
    eventTitle: string;
    yesBid?: number;
    yesAsk?: number;
    noBid?: number;
    noAsk?: number;
    mid?: number;
  };
  curated: boolean;
  confidence: number;
  /** low-trust pairs never carry arb math (arb is {}) */
  trust: 'curated' | 'high' | 'low';
  /** likely question mismatch or too-good-to-be-true; server ranks them last */
  suspect: boolean;
  /** in-play on the PM side; edges usually staleness */
  live?: boolean;
  /** pmMid − kalshiMid, dollars; positive = PM richer */
  gap?: number;
  arb: ArbQuote;
  /** quotes + edges re-derived from live order books */
  refreshed?: boolean;
}

export interface PairsTotals {
  pairs: number;
  curated: number;
  actionable: number;
  pmEvents: number;
  kalshiEvents: number;
  trackedPairs: number;
}

export interface PairsResponse {
  asOf: string;
  totals: PairsTotals;
  pairs: PairQuote[];
}

export interface GapSample {
  t: number;
  pmMid: number;
  kMid: number;
}

export interface GapStats {
  samples: number;
  firstT: number;
  lastT: number;
  maxAbsGap: number;
  meanGap: number;
}

export interface HistoryResponse {
  asOf: string;
  series: GapSample[];
  stats: GapStats | null;
}

export interface StatusResponse {
  asOf: string;
  authenticated: boolean;
  balance?: number;
}

async function getJson<T>(path: string, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s on ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The pairs scan re-verifies top books server-side; allow up to 90s. */
export const fetchPairs = (): Promise<PairsResponse> => getJson<PairsResponse>('/pairs', 90_000);

export const fetchHistory = (id: string, windowMs: number): Promise<HistoryResponse> =>
  getJson<HistoryResponse>(
    `/pairs/${encodeURIComponent(id)}/history?window=${windowMs}`,
    20_000,
  );

export const fetchStatus = (): Promise<StatusResponse> =>
  getJson<StatusResponse>('/status', 10_000);

/** Phantom edge: book-verified but nobody on the other side. */
export const isPhantom = (p: PairQuote): boolean =>
  Boolean(p.refreshed) && (p.arb.executableSets ?? 0) === 0;
