import { RateLimiter, TtlCache, fetchJson } from '../util/http.js';

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  outcome: string;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  lastPrice?: number;
  volume24h?: number;
  openInterest?: number;
}

export interface KalshiBookLevel {
  px: number;
  qty: number;
}

/**
 * Kalshi's order book lists resting BIDS per side (best level last in the
 * raw arrays; we return best-first). The YES ask is implied by the best NO
 * bid (yesAsk = 1 − noBid), so:
 *   buying YES at the ask fills against `no` levels;
 *   buying NO at the ask fills against `yes` levels.
 */
export interface KalshiOrderbook {
  yesBids: KalshiBookLevel[];
  noBids: KalshiBookLevel[];
}

export interface KalshiEvent {
  eventTicker: string;
  seriesTicker?: string;
  title: string;
  category?: string;
  markets: KalshiMarket[];
}

interface RawMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  yes_bid?: number;
  yes_ask?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid?: number;
  no_ask?: number;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price?: number;
  last_price_dollars?: string;
  volume_24h?: number;
  open_interest?: number;
  status?: string;
}

interface RawEvent {
  event_ticker: string;
  series_ticker?: string;
  title?: string;
  sub_title?: string;
  category?: string;
  markets?: RawMarket[];
}

const dollars = (d?: string, cents?: number): number | undefined => {
  if (d !== undefined) {
    const n = parseFloat(d);
    if (Number.isFinite(n)) return n;
  }
  if (cents !== undefined && Number.isFinite(cents)) return cents / 100;
  return undefined;
};

export class KalshiClient {
  private limiter = new RateLimiter(8);
  private cache = new TtlCache();

  /** All open events with nested markets; cursor-paginated. The open universe
   * runs well past 4,000 events, so the cap must stay generous or whole
   * series (e.g. Fed decisions) silently vanish from matching. */
  getOpenEvents(maxPages = 60): Promise<KalshiEvent[]> {
    return this.cache.getOrFetch('open-events', 120_000, async () => {
      const events: KalshiEvent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        await this.limiter.acquire();
        const qs = new URLSearchParams({
          limit: '200',
          status: 'open',
          with_nested_markets: 'true',
        });
        if (cursor) qs.set('cursor', cursor);
        const res = await fetchJson<{ cursor?: string; events?: RawEvent[] }>(
          `${BASE}/events?${qs}`,
        );
        for (const e of res.events ?? []) {
          events.push({
            eventTicker: e.event_ticker,
            seriesTicker: e.series_ticker,
            title: e.title ?? e.event_ticker,
            category: e.category,
            markets: (e.markets ?? [])
              .filter((m) => !m.status || m.status === 'active')
              .map((m) => ({
                ticker: m.ticker,
                eventTicker: m.event_ticker,
                title: m.title ?? e.title ?? m.ticker,
                outcome: m.yes_sub_title || m.subtitle || m.title || m.ticker,
                yesBid: dollars(m.yes_bid_dollars, m.yes_bid),
                yesAsk: dollars(m.yes_ask_dollars, m.yes_ask),
                noBid: dollars(m.no_bid_dollars, m.no_bid),
                noAsk: dollars(m.no_ask_dollars, m.no_ask),
                lastPrice: dollars(m.last_price_dollars, m.last_price),
                volume24h: m.volume_24h,
                openInterest: m.open_interest,
              })),
          });
        }
        cursor = res.cursor;
        if (!cursor || (res.events ?? []).length === 0) break;
      }
      return events;
    });
  }

  /** Public order book. Raw arrays are ascending; we return best-first. */
  getOrderbook(ticker: string): Promise<KalshiOrderbook> {
    return this.cache.getOrFetch(`book:${ticker}`, 5_000, async () => {
      await this.limiter.acquire();
      const res = await fetchJson<{
        orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };
        orderbook?: { yes?: [number, number][]; no?: [number, number][] };
      }>(`${BASE}/markets/${encodeURIComponent(ticker)}/orderbook?depth=10`);
      const parseFp = (levels?: [string, string][]): KalshiBookLevel[] =>
        (levels ?? [])
          .map(([px, qty]) => ({ px: parseFloat(px), qty: parseFloat(qty) }))
          .reverse();
      const parseCents = (levels?: [number, number][]): KalshiBookLevel[] =>
        (levels ?? []).map(([px, qty]) => ({ px: px / 100, qty })).reverse();
      const fp = res.orderbook_fp;
      if (fp) return { yesBids: parseFp(fp.yes_dollars), noBids: parseFp(fp.no_dollars) };
      return {
        yesBids: parseCents(res.orderbook?.yes),
        noBids: parseCents(res.orderbook?.no),
      };
    });
  }
}
