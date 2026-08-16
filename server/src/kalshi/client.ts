import { RateLimiter, TtlCache, fetchJson } from '../util/http.js';

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  outcome: string;
  yesBid?: number;
  yesAsk?: number;
  lastPrice?: number;
  volume24h?: number;
  openInterest?: number;
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

  /** All open events with nested markets; cursor-paginated, page count capped. */
  getOpenEvents(maxPages = 20): Promise<KalshiEvent[]> {
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
}
