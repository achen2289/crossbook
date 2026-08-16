/**
 * Typed fetch helpers mirroring the Polyscope server API contract
 * (server/src/routes/api.ts), plus a small data-fetching hook and
 * display formatters shared across the dashboard.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/* ------------------------------------------------------------------ */
/* Shared primitives                                                   */
/* ------------------------------------------------------------------ */

export interface Quote {
  value: string;
  currency?: string;
}

/** Coerce the API's number-or-string dollar fields. */
export const num = (v: number | string | undefined | null): number => {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** Parse a {value:string} price quote into dollars, or undefined. */
export const quotePx = (q?: Quote | null): number | undefined => {
  if (!q || !q.value) return undefined;
  const n = parseFloat(q.value);
  return Number.isFinite(n) ? n : undefined;
};

/* ------------------------------------------------------------------ */
/* Response shapes                                                     */
/* ------------------------------------------------------------------ */

export interface TopMarket {
  slug: string;
  title: string;
  bid?: number;
  ask?: number;
  mid?: number;
}

export interface EventSummary {
  slug: string;
  title: string;
  category?: string;
  image?: string;
  endDate?: string;
  live?: boolean;
  /** Sampled from per-market BBO polling; undefined until sampled (the list
   * API defines volume/OI fields but never populates them). */
  openInterest?: number;
  marketCount: number;
  topMarkets: TopMarket[];
}

export interface CategoryStat {
  category: string;
  events: number;
  openInterest: number;
}

export interface OverviewResponse {
  asOf: string;
  authenticated: boolean;
  totals: {
    events: number;
    markets: number;
    openInterest: number;
    liveEvents: number;
    sampledMarkets: number;
  };
  categories: CategoryStat[];
  topEvents: EventSummary[];
}

export interface EventsResponse {
  total: number;
  events: EventSummary[];
}

/** Subset of the raw Polymarket market object the UI reads. */
export interface PmMarket {
  id: string;
  slug: string;
  question?: string;
  title?: string;
  titleShort?: string;
  active?: boolean;
  closed?: boolean;
  hidden?: boolean;
  feeCoefficient?: number;
  bestAskQuote?: Quote;
  bestBidQuote?: Quote;
  endDate?: string;
  image?: string;
}

/** Subset of the raw Polymarket event object the UI reads. */
export interface PmEvent {
  id: string;
  slug: string;
  title: string;
  category?: string;
  live?: boolean;
  startDate?: string;
  endDate?: string;
  image?: string;
  markets?: PmMarket[];
}

export interface EventDetailResponse {
  event: PmEvent;
  scan: ScanGroup[];
}

export interface BookLevel {
  px: Quote;
  qty: string;
}

export interface BookData {
  marketSlug: string;
  bids?: BookLevel[];
  asks?: BookLevel[];
}

export interface BboData {
  marketSlug: string;
  currentPx?: Quote;
  lastTradePx?: Quote;
  settlementPx?: Quote;
  sharesTraded?: string;
  openInterest?: string;
  bestAsk?: Quote;
  bestBid?: Quote;
  askDepth?: number;
  bidDepth?: number;
}

export interface BookResponse {
  book: BookData;
  bbo: BboData;
}

export interface ScanLeg {
  marketSlug: string;
  title: string;
  bid?: number;
  ask?: number;
  mid?: number;
  /** Per-market taker fee coefficient (default 0.06). */
  theta: number;
  feeAtAsk: number;
  feeAtBid: number;
}

export interface ScanGroup {
  eventSlug: string;
  eventTitle: string;
  eventCategory?: string;
  groupTitle: string;
  legCount: number;
  complete: boolean;
  sumAsk: number;
  sumBid: number;
  sumMid: number;
  partitionScore: number;
  /** -1 sentinel when any leg lacks an ask — render as n/a, not -100%. */
  longEdgeGross: number;
  longEdgeNet: number;
  /** -1 sentinel when any leg lacks a bid — render as n/a, not -100%. */
  shortEdgeGross: number;
  shortEdgeNet: number;
  kind: 'long' | 'short' | 'none';
  /** True when legs were re-priced from live book tops (vs embedded quotes). */
  refreshed?: boolean;
  executableLongSets?: number;
  executableShortSets?: number;
  legs: ScanLeg[];
}

export interface ScanResponse {
  asOf: string;
  universe: number;
  /** Candidate groups examined across the universe. */
  scanned: number;
  groups: ScanGroup[];
}

export interface VenueQuote {
  id: string;
  title: string;
  eventTitle: string;
  bid?: number;
  ask?: number;
  mid?: number;
}

export interface MarketMatch {
  pm: VenueQuote;
  kalshi: VenueQuote;
  eventScore: number;
  outcomeScore: number;
  confidence: number;
  /** pm.mid - kalshi.mid, in dollars; positive = Polymarket prices it higher. */
  divergence: number;
  /** Gaps this large are usually a semantic mismatch (different question),
   * not a real cross-venue disagreement — server sorts these last. */
  suspect: boolean;
}

export interface CompareResponse {
  asOf: string;
  pmEvents: number;
  kalshiEvents: number;
  matches: MarketMatch[];
}

export interface Mover {
  marketSlug: string;
  title: string;
  eventSlug: string;
  eventTitle: string;
  mid: number;
  prevMid: number;
  delta: number;
  sinceMs: number;
}

export interface MoversResponse {
  asOf: string;
  trackingSince: string;
  movers: Mover[];
}

export interface Balance {
  currentBalance?: number | string;
  currency?: string;
  buyingPower?: number | string;
  assetNotional?: number | string;
  openOrders?: number | string;
  unsettledFunds?: number | string;
}

export interface AccountResponse {
  authenticated: boolean;
  balances?: { balances?: Balance[] };
  positions?: unknown;
  openOrders?: unknown;
}

/* ------------------------------------------------------------------ */
/* Fetch helpers                                                       */
/* ------------------------------------------------------------------ */

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 140);
    } catch {
      /* body unreadable; status alone is enough */
    }
    throw new Error(`HTTP ${res.status} on ${path}${detail ? ` — ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

export interface EventsQuery {
  category?: string;
  q?: string;
  sort?: 'openInterest' | 'endDate' | 'markets' | 'featured';
  limit?: number;
  offset?: number;
}

export const api = {
  overview: () => getJson<OverviewResponse>('/api/overview'),
  events: (query: EventsQuery = {}) => {
    const p = new URLSearchParams();
    if (query.category) p.set('category', query.category);
    if (query.q) p.set('q', query.q);
    if (query.sort) p.set('sort', query.sort);
    if (query.limit !== undefined) p.set('limit', String(query.limit));
    if (query.offset !== undefined) p.set('offset', String(query.offset));
    const qs = p.toString();
    return getJson<EventsResponse>(`/api/events${qs ? `?${qs}` : ''}`);
  },
  event: (slug: string) => getJson<EventDetailResponse>(`/api/events/${encodeURIComponent(slug)}`),
  book: (slug: string) => getJson<BookResponse>(`/api/markets/${encodeURIComponent(slug)}/book`),
  scan: (all: boolean) => getJson<ScanResponse>(`/api/scan${all ? '?all=1' : ''}`),
  compare: () => getJson<CompareResponse>('/api/compare'),
  movers: (windowMs: number) => getJson<MoversResponse>(`/api/movers?window=${windowMs}`),
  account: () => getJson<AccountResponse>('/api/account'),
};

/* ------------------------------------------------------------------ */
/* Data hook                                                           */
/* ------------------------------------------------------------------ */

export interface ApiState<T> {
  data?: T;
  error?: string;
  /** True only for the very first load (no data yet). */
  loading: boolean;
  /** True while refetching with previous data still on screen. */
  refreshing: boolean;
}

export interface ApiHandle<T> extends ApiState<T> {
  reload: () => void;
}

/**
 * Fetch-on-mount hook with optional auto-refresh. On refetch the previous
 * data is held (dimmed by the caller) instead of flashing a skeleton.
 */
export function useApi<T>(
  fn: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
  refreshMs?: number,
): ApiHandle<T> {
  const [state, setState] = useState<ApiState<T>>({ loading: true, refreshing: false });
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setState((s) =>
      s.data === undefined
        ? { loading: true, refreshing: false }
        : { ...s, error: undefined, refreshing: true },
    );
    fnRef.current().then(
      (data) => {
        if (alive) setState({ data, loading: false, refreshing: false });
      },
      (err: unknown) => {
        if (!alive) return;
        const message = err instanceof Error ? err.message : String(err);
        setState((s) => ({ ...s, error: message, loading: false, refreshing: false }));
      },
    );
    return () => {
      alive = false;
    };
    // deps are spread intentionally; fnRef keeps the closure fresh.
  }, [...deps, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!refreshMs) return;
    const id = window.setInterval(() => setNonce((n) => n + 1), refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}

/* ------------------------------------------------------------------ */
/* Formatters                                                          */
/* ------------------------------------------------------------------ */

/** Shared tooltip for every "open interest (sampled)" label. */
export const SAMPLED_OI_TOOLTIP =
  "Sampled via rotating BBO polls — the public list API doesn't populate volume/OI fields";

/** Compact dollars: $1.23B / $4.56M / $7.8K / $12. */
export function fmtUsd(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

/** Contract price in cents, one decimal: 43.5¢. */
export function fmtCents(p?: number): string {
  return p === undefined ? '—' : `${(p * 100).toFixed(1)}¢`;
}

/** Contract price in cents, two decimals (fees, small edges). */
export function fmtCents2(p?: number): string {
  return p === undefined ? '—' : `${(p * 100).toFixed(2)}¢`;
}

/** Probability as a percent. */
export function fmtPct(p?: number, digits = 1): string {
  return p === undefined ? '—' : `${(p * 100).toFixed(digits)}%`;
}

/** Basket sums (Σask/Σbid/Σmid) in dollars. */
export function fmtSum(v: number): string {
  return `$${v.toFixed(3)}`;
}

/** Signed edge in cents per $1 set: +1.25¢ / -0.40¢. */
export function fmtEdge(v: number): string {
  return `${v >= 0 ? '+' : '-'}${Math.abs(v * 100).toFixed(2)}¢`;
}

/** Signed mid move in probability points: +4.2pt. */
export function fmtDelta(v: number): string {
  return `${v >= 0 ? '+' : '-'}${Math.abs(v * 100).toFixed(1)}pt`;
}

/** Share/contract quantity with thousands separators. */
export function fmtQty(v: number | string | undefined): string {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtAgo(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

/* ------------------------------------------------------------------ */
/* Raw-market helpers                                                  */
/* ------------------------------------------------------------------ */

export function marketTitle(m: PmMarket): string {
  return m.titleShort || m.title || m.question || m.slug;
}

export function marketQuotes(m: PmMarket): {
  bid?: number;
  ask?: number;
  mid?: number;
  spread?: number;
} {
  const bid = quotePx(m.bestBidQuote);
  const ask = quotePx(m.bestAskQuote);
  const mid = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : bid ?? ask;
  const spread = bid !== undefined && ask !== undefined ? ask - bid : undefined;
  return { bid, ask, mid, spread };
}
