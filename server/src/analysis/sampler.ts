import type { PmusClient } from '../pmus/client.js';
import type { PmEvent } from '../pmus/types.js';

/**
 * The retail list endpoints define volume/liquidity/openInterest fields but
 * never populate them (verified live). Per-market BBO responses DO carry real
 * openInterest and sharesTraded, so we sample: each cycle, BBO-poll a rotating
 * window of "interesting" markets (live events first, then soonest-ending)
 * and accumulate the latest reading per market. Rankings degrade gracefully
 * while coverage builds.
 */

export interface ActivityReading {
  openInterest: number;
  sharesTraded: number;
  lastTradePx?: number;
  at: number;
}

export class ActivitySampler {
  private readings = new Map<string, ActivityReading>();
  private cursor = 0;

  constructor(
    private pmus: PmusClient,
    private perCycle = 100,
  ) {}

  get coverage(): number {
    return this.readings.size;
  }

  reading(marketSlug: string): ActivityReading | undefined {
    return this.readings.get(marketSlug);
  }

  eventOpenInterest(ev: PmEvent): number | undefined {
    let sum = 0;
    let known = 0;
    for (const m of ev.markets ?? []) {
      const r = this.readings.get(m.slug);
      if (r) {
        sum += r.openInterest;
        known++;
      }
    }
    return known > 0 ? sum : undefined;
  }

  /** Markets worth sampling, hot-first: live events, then soonest end date. */
  private candidates(events: PmEvent[]): string[] {
    const scored = events
      .filter((e) => e.active !== false && e.closed !== true)
      .map((e) => ({
        e,
        score: e.live ? 0 : Date.parse(e.endDate ?? '') || Number.MAX_SAFE_INTEGER,
      }))
      .sort((a, b) => a.score - b.score);
    const slugs: string[] = [];
    for (const { e } of scored) {
      for (const m of e.markets ?? []) {
        if (m.active !== false && m.closed !== true) slugs.push(m.slug);
      }
      if (slugs.length >= 2000) break;
    }
    return slugs;
  }

  async cycle(events: PmEvent[]): Promise<void> {
    const slugs = this.candidates(events);
    if (slugs.length === 0) return;
    const batch: string[] = [];
    for (let i = 0; i < Math.min(this.perCycle, slugs.length); i++) {
      batch.push(slugs[(this.cursor + i) % slugs.length]);
    }
    this.cursor = (this.cursor + batch.length) % slugs.length;
    await Promise.all(
      batch.map(async (slug) => {
        try {
          const { marketData } = await this.pmus.getMarketBbo(slug);
          this.readings.set(slug, {
            openInterest: parseFloat(marketData.openInterest ?? '0') || 0,
            sharesTraded: parseFloat(marketData.sharesTraded ?? '0') || 0,
            lastTradePx: marketData.lastTradePx
              ? parseFloat(marketData.lastTradePx.value)
              : undefined,
            at: Date.now(),
          });
        } catch {
          // Sampling is best-effort; skip failures and move on.
        }
      }),
    );
  }
}
