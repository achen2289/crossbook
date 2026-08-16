import { Router } from 'express';
import type { PmusClient } from '../pmus/client.js';
import type { KalshiClient } from '../kalshi/client.js';
import type { ActivitySampler } from '../analysis/sampler.js';
import type { PriceTracker } from '../analysis/tracker.js';
import { matchVenues } from '../analysis/matcher.js';
import { computeGroupMetrics, scanEvent, scanUniverse } from '../analysis/scanner.js';
import type { ScanGroup } from '../analysis/scanner.js';
import { takerFeePerContract } from '../analysis/fees.js';
import { quotePx } from '../pmus/types.js';
import type { PmEvent } from '../pmus/types.js';

interface EventSummary {
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
  topMarkets: { slug: string; title: string; bid?: number; ask?: number; mid?: number }[];
}

function summarize(ev: PmEvent, sampler?: ActivitySampler): EventSummary {
  const markets = (ev.markets ?? []).filter((m) => m.active !== false && m.closed !== true);
  const quoted = markets
    .map((m) => {
      const bid = quotePx(m.bestBidQuote);
      const ask = quotePx(m.bestAskQuote);
      return {
        slug: m.slug,
        title: m.titleShort || m.title || m.question || m.slug,
        bid,
        ask,
        mid: bid !== undefined && ask !== undefined ? (bid + ask) / 2 : bid ?? ask,
      };
    })
    .sort((a, b) => (b.mid ?? 0) - (a.mid ?? 0));
  return {
    slug: ev.slug,
    title: ev.title,
    category: ev.category,
    image: ev.image,
    endDate: ev.endDate,
    live: ev.live,
    openInterest: sampler?.eventOpenInterest(ev),
    marketCount: markets.length,
    topMarkets: quoted.slice(0, 4),
  };
}

/**
 * Embedded event quotes lag the matching engine, so candidate groups are
 * re-priced from live book tops before we present them: legs get fresh
 * bid/ask, edges and kind are recomputed, and executable size is the minimum
 * top-of-book quantity across legs.
 */
async function refreshFromBooks(pmus: PmusClient, groups: ScanGroup[], maxGroups: number) {
  const targets = groups
    .filter((g) => g.partitionScore >= 0.96 && g.legs.length <= 12)
    .sort((a, b) => Math.max(b.longEdgeNet, b.shortEdgeNet) - Math.max(a.longEdgeNet, a.shortEdgeNet))
    .slice(0, maxGroups);
  await Promise.all(
    targets.map(async (g) => {
      try {
        const books = await Promise.all(
          g.legs.map((leg) => pmus.getMarketBook(leg.marketSlug)),
        );
        let minLongSets = Infinity;
        let minShortSets = Infinity;
        books.forEach((book, i) => {
          const leg = g.legs[i];
          const bestAsk = book.marketData.asks?.[0];
          const bestBid = book.marketData.bids?.[0];
          leg.ask = bestAsk ? parseFloat(bestAsk.px.value) : undefined;
          leg.bid = bestBid ? parseFloat(bestBid.px.value) : undefined;
          leg.mid =
            leg.ask !== undefined && leg.bid !== undefined
              ? (leg.ask + leg.bid) / 2
              : leg.ask ?? leg.bid;
          leg.feeAtAsk = leg.ask !== undefined ? takerFeePerContract(leg.ask, leg.theta) : 0;
          leg.feeAtBid = leg.bid !== undefined ? takerFeePerContract(leg.bid, leg.theta) : 0;
          minLongSets = Math.min(minLongSets, bestAsk ? parseFloat(bestAsk.qty) : 0);
          minShortSets = Math.min(minShortSets, bestBid ? parseFloat(bestBid.qty) : 0);
        });
        Object.assign(g, computeGroupMetrics(g.legs));
        g.refreshed = true;
        g.executableLongSets = Number.isFinite(minLongSets) ? minLongSets : 0;
        g.executableShortSets = Number.isFinite(minShortSets) ? minShortSets : 0;
      } catch {
        // Book fetch is best-effort; the row stands on embedded quotes.
      }
    }),
  );
}

export function apiRouter(
  pmus: PmusClient,
  kalshi: KalshiClient,
  tracker: PriceTracker,
  sampler: ActivitySampler,
): Router {
  const router = Router();

  router.get('/overview', async (_req, res, next) => {
    try {
      const events = await pmus.getAllActiveEvents();
      const byCategory = new Map<string, { category: string; events: number; openInterest: number }>();
      let markets = 0;
      let openInterest = 0;
      let liveCount = 0;
      for (const ev of events) {
        markets += (ev.markets ?? []).length;
        const oi = sampler.eventOpenInterest(ev) ?? 0;
        openInterest += oi;
        if (ev.live) liveCount++;
        const cat = ev.category ?? 'other';
        const c = byCategory.get(cat) ?? { category: cat, events: 0, openInterest: 0 };
        c.events++;
        c.openInterest += oi;
        byCategory.set(cat, c);
      }
      // Rank by sampled open interest; unsampled events keep API (featured) order.
      const topEvents = [...events]
        .sort(
          (a, b) => (sampler.eventOpenInterest(b) ?? -1) - (sampler.eventOpenInterest(a) ?? -1),
        )
        .slice(0, 12)
        .map((e) => summarize(e, sampler));
      res.json({
        asOf: new Date().toISOString(),
        authenticated: pmus.isAuthenticated,
        totals: {
          events: events.length,
          markets,
          openInterest,
          liveEvents: liveCount,
          sampledMarkets: sampler.coverage,
        },
        categories: [...byCategory.values()].sort((a, b) => b.openInterest - a.openInterest),
        topEvents,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/events', async (req, res, next) => {
    try {
      const { category, q, sort = 'openInterest', limit = '50', offset = '0' } = req.query as Record<string, string>;
      let events = await pmus.getAllActiveEvents();
      if (category) events = events.filter((e) => e.category === category);
      if (q) {
        const needle = q.toLowerCase();
        events = events.filter((e) => e.title.toLowerCase().includes(needle));
      }
      if (sort === 'endDate') {
        events = [...events].sort(
          (a, b) => (Date.parse(a.endDate ?? '') || Infinity) - (Date.parse(b.endDate ?? '') || Infinity),
        );
      } else if (sort === 'markets') {
        events = [...events].sort((a, b) => (b.markets?.length ?? 0) - (a.markets?.length ?? 0));
      } else if (sort === 'openInterest') {
        events = [...events].sort(
          (a, b) => (sampler.eventOpenInterest(b) ?? -1) - (sampler.eventOpenInterest(a) ?? -1),
        );
      } // 'featured' keeps API order
      const off = parseInt(offset, 10) || 0;
      const lim = Math.min(parseInt(limit, 10) || 50, 200);
      res.json({
        total: events.length,
        events: events.slice(off, off + lim).map((e) => summarize(e, sampler)),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/events/:slug', async (req, res, next) => {
    try {
      const { event } = await pmus.getEventBySlug(req.params.slug);
      res.json({ event, scan: scanEvent(event) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/markets/:slug/book', async (req, res, next) => {
    try {
      const [book, bbo] = await Promise.all([
        pmus.getMarketBook(req.params.slug),
        pmus.getMarketBbo(req.params.slug),
      ]);
      res.json({ book: book.marketData, bbo: bbo.marketData });
    } catch (err) {
      next(err);
    }
  });

  router.get('/scan', async (req, res, next) => {
    try {
      const includeAll = req.query.all === '1';
      const events = await pmus.getAllActiveEvents();
      // Always scan the whole universe including 'none' groups, so near-misses
      // are re-priced from live books before we decide what's actionable.
      const groups = scanUniverse(events, { includeAll: true });
      await refreshFromBooks(pmus, groups, 15);
      // Verified/flagged rows first, then by best net edge — otherwise stale
      // unrefreshed quotes outrank live-book-confirmed opportunities.
      const rank = (g: ScanGroup) =>
        (g.kind !== 'none' ? 10 : 0) + Math.max(g.longEdgeNet, g.shortEdgeNet);
      groups.sort((a, b) => rank(b) - rank(a));
      const visible = includeAll ? groups : groups.filter((g) => g.kind !== 'none');
      res.json({
        asOf: new Date().toISOString(),
        universe: events.length,
        scanned: groups.length,
        groups: visible.slice(0, includeAll ? 200 : 50),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/compare', async (_req, res, next) => {
    try {
      const [pmEvents, kEvents] = await Promise.all([
        pmus.getAllActiveEvents(),
        kalshi.getOpenEvents(),
      ]);
      const matches = matchVenues(pmEvents, kEvents);
      res.json({
        asOf: new Date().toISOString(),
        pmEvents: pmEvents.length,
        kalshiEvents: kEvents.length,
        matches: matches.slice(0, 100),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/movers', (req, res) => {
    const windowMs = Math.min(parseInt(String(req.query.window ?? '3600000'), 10) || 3_600_000, 7_200_000);
    res.json({
      asOf: new Date().toISOString(),
      trackingSince: new Date(tracker.startedAt).toISOString(),
      movers: tracker.movers(windowMs),
    });
  });

  router.get('/account', async (_req, res, next) => {
    try {
      if (!pmus.isAuthenticated) {
        res.json({ authenticated: false });
        return;
      }
      const [balances, positions, openOrders] = await Promise.all([
        pmus.getBalances(),
        pmus.getPositions(),
        pmus.getOpenOrders(),
      ]);
      res.json({ authenticated: true, balances, positions, openOrders });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
