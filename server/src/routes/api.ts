import { Router } from 'express';
import type { PmusClient } from '../pmus/client.js';
import type { KalshiClient } from '../kalshi/client.js';
import { TtlCache } from '../util/http.js';
import type { GapHistory } from '../analysis/history.js';
import { buildPairs, computeExecutable, sortPairs } from '../analysis/pairs.js';
import type { CuratedPair, PairQuote } from '../analysis/pairs.js';

export interface PairsDeps {
  pmus: PmusClient;
  kalshi: KalshiClient;
  history: GapHistory;
  curated: CuratedPair[];
}

const pairsCache = new TtlCache();

export async function currentPairs(deps: PairsDeps): Promise<{
  pairs: PairQuote[];
  pmEvents: number;
  kalshiEvents: number;
}> {
  // Matching over the full universes is CPU-heavy; build once per cycle and
  // share between the sampling loop and request handlers.
  return pairsCache.getOrFetch('pairs', 30_000, async () => {
    const [pmEvents, kEvents] = await Promise.all([
      deps.pmus.getAllActiveEvents(),
      deps.kalshi.getOpenEvents(),
    ]);
    return {
      pairs: buildPairs(pmEvents, kEvents, deps.curated),
      pmEvents: pmEvents.length,
      kalshiEvents: kEvents.length,
    };
  });
}

export function apiRouter(deps: PairsDeps): Router {
  const router = Router();

  router.get('/pairs', async (_req, res, next) => {
    try {
      const { pairs, pmEvents, kalshiEvents } = await currentPairs(deps);
      // Verify the most promising pairs against live order books before
      // anyone reads the edge column as money. Low-trust pairs carry no
      // arb math at all, so they never qualify.
      const targets = pairs
        .filter((p) => p.trust !== 'low' && !p.suspect && (p.arb.bestEdge ?? -1) > -0.03)
        .slice(0, 12);
      await Promise.all(
        targets.map((p) =>
          computeExecutable(p, deps.pmus, deps.kalshi).catch(() => {
            /* enrichment is best-effort */
          }),
        ),
      );
      sortPairs(pairs);
      res.json({
        asOf: new Date().toISOString(),
        totals: {
          pairs: pairs.length,
          curated: pairs.filter((p) => p.curated).length,
          actionable: pairs.filter(
            (p) =>
              (p.arb.bestEdge ?? 0) > 0 &&
              !p.suspect &&
              !(p.refreshed && (p.arb.executableSets ?? 0) === 0),
          ).length,
          pmEvents,
          kalshiEvents,
          trackedPairs: deps.history.trackedPairs,
        },
        pairs: pairs.slice(0, 150),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/pairs/:id/history', (req, res) => {
    const windowMs = Math.min(
      parseInt(String(req.query.window ?? String(48 * 3600 * 1000)), 10) || 48 * 3600 * 1000,
      48 * 3600 * 1000,
    );
    res.json({
      asOf: new Date().toISOString(),
      series: deps.history.serie(req.params.id, windowMs),
      stats: deps.history.stats(req.params.id) ?? null,
    });
  });

  router.get('/status', async (_req, res) => {
    let balance: number | undefined;
    if (deps.pmus.isAuthenticated) {
      try {
        const b = await deps.pmus.getBalances();
        balance = b.balances?.[0]?.currentBalance;
      } catch {
        // Status stays useful without the balance.
      }
    }
    res.json({
      asOf: new Date().toISOString(),
      authenticated: deps.pmus.isAuthenticated,
      balance,
    });
  });

  return router;
}
