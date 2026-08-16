import type crypto from 'node:crypto';
import { authHeaders, privateKeyFromSecret } from './sign.js';
import { RateLimiter, TtlCache, fetchJson } from '../util/http.js';
import type {
  BalancesResponse,
  BboResponse,
  BookResponse,
  PmEvent,
} from './types.js';

const GATEWAY = 'https://gateway.polymarket.us';
const API = 'https://api.polymarket.us';

export interface PmusClientOptions {
  keyId?: string;
  secret?: string;
  ratePerSec?: number;
}

interface EventsResponse {
  events?: PmEvent[];
}

export class PmusClient {
  private key?: crypto.KeyObject;
  private keyId?: string;
  private limiter: RateLimiter;
  private cache = new TtlCache();

  constructor(opts: PmusClientOptions = {}) {
    if (opts.keyId && opts.secret) {
      this.keyId = opts.keyId;
      this.key = privateKeyFromSecret(opts.secret);
    }
    this.limiter = new RateLimiter(opts.ratePerSec ?? 10);
  }

  get isAuthenticated(): boolean {
    return Boolean(this.key && this.keyId);
  }

  private async get<T>(
    base: string,
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    auth = false,
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const url = `${base}${path}${qs.size ? `?${qs}` : ''}`;
    let headers: Record<string, string> = {};
    if (auth) {
      if (!this.key || !this.keyId) throw new Error('PMUS credentials not configured');
      // Sign the path only — never the query string (gateway rejects it).
      headers = authHeaders(this.keyId, this.key, 'GET', path);
    }
    await this.limiter.acquire();
    return fetchJson<T>(url, { headers });
  }

  // ------- public market data (gateway.polymarket.us) -------

  async listEvents(params: {
    limit?: number;
    offset?: number;
    active?: boolean;
    closed?: boolean;
    orderBy?: string;
    orderDirection?: string;
  } = {}): Promise<PmEvent[]> {
    const res = await this.get<EventsResponse>(GATEWAY, '/v1/events', {
      limit: params.limit ?? 500,
      offset: params.offset ?? 0,
      active: params.active,
      closed: params.closed,
      orderBy: params.orderBy,
      orderDirection: params.orderDirection,
    });
    return res.events ?? [];
  }

  /** All active, open events — paginated; cached briefly to stay far under rate limits. */
  getAllActiveEvents(): Promise<PmEvent[]> {
    return this.cache.getOrFetch('active-events', 45_000, async () => {
      const pageSize = 500;
      // Dedupe by slug: the listing can shift between page fetches, so the
      // same event may appear on two consecutive pages.
      const bySlug = new Map<string, PmEvent>();
      for (let offset = 0; offset < 5000; offset += pageSize) {
        const page = await this.listEvents({
          limit: pageSize,
          offset,
          active: true,
          closed: false,
        });
        for (const ev of page) bySlug.set(ev.slug, ev);
        if (page.length < pageSize) break;
      }
      return [...bySlug.values()];
    });
  }

  getEventBySlug(slug: string): Promise<{ event: PmEvent }> {
    return this.cache.getOrFetch(`event:${slug}`, 15_000, () =>
      this.get<{ event: PmEvent }>(GATEWAY, `/v1/events/slug/${encodeURIComponent(slug)}`),
    );
  }

  getMarketBbo(slug: string): Promise<BboResponse> {
    return this.get<BboResponse>(GATEWAY, `/v1/markets/${encodeURIComponent(slug)}/bbo`);
  }

  getMarketBook(slug: string): Promise<BookResponse> {
    return this.cache.getOrFetch(`book:${slug}`, 5_000, async () => {
      const res = await this.get<BookResponse>(
        GATEWAY,
        `/v1/markets/${encodeURIComponent(slug)}/book`,
      );
      // Live responses name the ask side `offers` (the spec and BBO say
      // "ask"); normalize so downstream code has one spelling.
      if (!res.marketData.asks && res.marketData.offers) {
        res.marketData.asks = res.marketData.offers;
      }
      return res;
    });
  }

  search(query: string, limit = 10): Promise<unknown> {
    return this.get(GATEWAY, '/v1/search', { query, limit });
  }

  // ------- authenticated (api.polymarket.us) -------

  getBalances(): Promise<BalancesResponse> {
    return this.cache.getOrFetch('balances', 15_000, () =>
      this.get<BalancesResponse>(API, '/v1/account/balances', undefined, true),
    );
  }

  getPositions(): Promise<unknown> {
    return this.cache.getOrFetch('positions', 15_000, () =>
      this.get(API, '/v1/portfolio/positions', { limit: 100 }, true),
    );
  }

  getOpenOrders(): Promise<unknown> {
    return this.cache.getOrFetch('open-orders', 15_000, () =>
      this.get(API, '/v1/orders/open', undefined, true),
    );
  }
}
