import { describe, expect, it } from 'vitest';
import { jaccard, matchVenues, tokenize } from '../src/analysis/matcher.js';
import type { PmEvent, PmMarket } from '../src/pmus/types.js';
import type { KalshiEvent } from '../src/kalshi/client.js';

describe('tokenize', () => {
  it('normalizes Fed vocabulary: hike→increase, bps→bp, stopwords dropped', () => {
    const t = tokenize('Will the Fed hike 25 bps?');
    expect(t.has('increase')).toBe(true);
    expect(t.has('25')).toBe(true);
    expect(t.has('bp')).toBe(true);
    expect(t.has('fed')).toBe(true);
    // Stopwords and pre-synonym forms must not survive.
    expect(t.has('will')).toBe(false);
    expect(t.has('the')).toBe(false);
    expect(t.has('hike')).toBe(false);
    expect(t.has('bps')).toBe(false);
  });

  it('maps cut→decrease and treats hyphens as separators', () => {
    const t = tokenize('Fed rate-cut in 2026');
    expect(t.has('decrease')).toBe(true);
    expect(t.has('cut')).toBe(false);
    expect(t.has('rate')).toBe(true);
    expect(t.has('2026')).toBe(false); // year stopword
  });

  it('expands "+" to plus', () => {
    const t = tokenize('Hike 25+ bps');
    expect(t.has('plus')).toBe(true);
    expect(t.has('25')).toBe(true);
    expect(t.has('bp')).toBe(true);
  });
});

describe('jaccard', () => {
  it('returns 0 when either set is empty', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  it('returns 1 for identical sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('computes |∩| / |∪| for partial overlap', () => {
    // {a,b} ∩ {b,c} = {b}; union = {a,b,c} → 1/3.
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3, 12);
  });
});

function pmMkt(slug: string, titleShort: string, bid?: number, ask?: number): PmMarket {
  return {
    id: slug,
    slug,
    titleShort,
    bestBidQuote: bid !== undefined ? { value: String(bid), currency: 'USD' } : undefined,
    bestAskQuote: ask !== undefined ? { value: String(ask), currency: 'USD' } : undefined,
  };
}

const pmFed: PmEvent = {
  id: 'ev-fed',
  slug: 'fed-decision-september',
  title: 'Fed rate decision in September',
  markets: [
    pmMkt('fed-hike-25', 'Hike 25 bps', 0.3, 0.34),
    pmMkt('fed-no-change', 'No change', 0.55, 0.6),
  ],
};

const kalshiFed: KalshiEvent = {
  eventTicker: 'KXFED-SEP',
  title: 'Fed rate decision in September',
  markets: [
    {
      ticker: 'KXFED-SEP-H25',
      eventTicker: 'KXFED-SEP',
      title: 'Fed decision',
      outcome: '25 bps increase',
      yesBid: 0.25,
      yesAsk: 0.27,
    },
    {
      ticker: 'KXFED-SEP-NC',
      eventTicker: 'KXFED-SEP',
      title: 'Fed decision',
      outcome: 'No change',
      yesBid: 0.6,
      yesAsk: 0.62,
    },
  ],
};

const kalshiUnrelated: KalshiEvent = {
  eventTicker: 'KXNBA-CHAMP',
  title: 'NBA championship winner',
  markets: [
    {
      ticker: 'KXNBA-CHAMP-BOS',
      eventTicker: 'KXNBA-CHAMP',
      title: 'NBA champ',
      outcome: 'Celtics',
      yesBid: 0.2,
      yesAsk: 0.22,
    },
  ],
};

describe('matchVenues', () => {
  it('matches hike-25 style outcomes across venues and reports divergence = pmMid - kMid', () => {
    const matches = matchVenues([pmFed], [kalshiFed, kalshiUnrelated]);
    expect(matches).toHaveLength(2);

    const hike = matches.find((m) => m.pm.id === 'fed-hike-25');
    expect(hike).toBeDefined();
    // "Hike 25 bps" ↔ "25 bps increase" via hike→increase, bps→bp synonyms.
    expect(hike!.kalshi.id).toBe('KXFED-SEP-H25');
    expect(hike!.eventScore).toBeGreaterThanOrEqual(0.45);
    expect(hike!.outcomeScore).toBeGreaterThanOrEqual(0.34);
    expect(hike!.confidence).toBeCloseTo(hike!.eventScore * hike!.outcomeScore, 12);
    // pmMid = (0.30+0.34)/2 = 0.32; kMid = (0.25+0.27)/2 = 0.26.
    expect(hike!.pm.mid).toBeCloseTo(0.32, 12);
    expect(hike!.kalshi.mid).toBeCloseTo(0.26, 12);
    expect(hike!.divergence).toBeCloseTo(0.06, 12);

    const noChange = matches.find((m) => m.pm.id === 'fed-no-change');
    expect(noChange).toBeDefined();
    expect(noChange!.kalshi.id).toBe('KXFED-SEP-NC');
    // pmMid = 0.575; kMid = 0.61 → divergence -0.035 (Kalshi prices it higher).
    expect(noChange!.divergence).toBeCloseTo(0.575 - 0.61, 12);

    // Sorted by |divergence| descending: 0.06 before 0.035.
    expect(matches[0].pm.id).toBe('fed-hike-25');
  });

  it('does not match an unrelated Kalshi event', () => {
    expect(matchVenues([pmFed], [kalshiUnrelated])).toEqual([]);
  });

  it('yields no match when event similarity is below the 0.45 threshold', () => {
    const vaguelyRelated: KalshiEvent = {
      eventTicker: 'KXFEDFUNDS',
      // Shares only {fed, rate} with the PM title → jaccard 2/9 < 0.45.
      title: 'Fed funds rate upper bound at end of year',
      markets: kalshiFed.markets,
    };
    expect(matchVenues([pmFed], [vaguelyRelated])).toEqual([]);
  });

  it('yields no match when outcome similarity is below the 0.34 threshold', () => {
    const sameEventDifferentOutcomes: KalshiEvent = {
      ...kalshiFed,
      markets: [
        {
          ticker: 'KXFED-SEP-EMERGENCY',
          eventTicker: 'KXFED-SEP',
          title: 'Fed decision',
          outcome: 'Emergency intermeeting move',
          yesBid: 0.01,
          yesAsk: 0.03,
        },
      ],
    };
    expect(matchVenues([pmFed], [sameEventDifferentOutcomes])).toEqual([]);
  });

  it('skips PM markets and Kalshi markets that lack two-sided quotes', () => {
    const pmOneSided: PmEvent = {
      ...pmFed,
      markets: [pmMkt('fed-hike-25', 'Hike 25 bps', undefined, 0.34)],
    };
    expect(matchVenues([pmOneSided], [kalshiFed])).toEqual([]);

    const kalshiNoQuotes: KalshiEvent = {
      ...kalshiFed,
      markets: kalshiFed.markets.map((m) => ({ ...m, yesBid: undefined })),
    };
    expect(matchVenues([pmFed], [kalshiNoQuotes])).toEqual([]);
  });
});
