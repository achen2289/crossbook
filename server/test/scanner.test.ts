import { describe, expect, it } from 'vitest';
import { groupsForEvent, scanEvent, scanUniverse } from '../src/analysis/scanner.js';
import type { PmEvent, PmMarket } from '../src/pmus/types.js';

const THETA = 0.06;
const fee = (p: number) => THETA * p * (1 - p);

function mkt(
  slug: string,
  bid: number | undefined,
  ask: number | undefined,
  extra: Partial<PmMarket> = {},
): PmMarket {
  return {
    id: slug,
    slug,
    title: slug,
    bestBidQuote: bid !== undefined ? { value: String(bid), currency: 'USD' } : undefined,
    bestAskQuote: ask !== undefined ? { value: String(ask), currency: 'USD' } : undefined,
    ...extra,
  };
}

function evt(slug: string, markets: PmMarket[], extra: Partial<PmEvent> = {}): PmEvent {
  return { id: slug, slug, title: `Event ${slug}`, markets, ...extra };
}

/** (a) 3-outcome partition, Σask = 0.97, Σbid = 0.94 → long edge. */
const longEvent = evt('long-partition', [
  mkt('long-a', 0.88, 0.9),
  mkt('long-b', 0.04, 0.05),
  mkt('long-c', 0.02, 0.02),
]);
const LONG_ASKS = [0.9, 0.05, 0.02];
const LONG_BIDS = [0.88, 0.04, 0.02];

/** (b) Σbid = 1.05 → short edge. Zero-spread quotes keep Σmid = 1.05, inside
 * the short gate (Σmid ≤ 1.05 guards against nested, non-exclusive ladders). */
const shortEvent = evt('short-partition', [
  mkt('short-a', 0.95, 0.95),
  mkt('short-b', 0.06, 0.06),
  mkt('short-c', 0.04, 0.04),
]);
const SHORT_BIDS = [0.95, 0.06, 0.04];

/** (c) win-total ladder: cumulative markets, Σmid = 2.4 — not a partition. */
const ladderEvent = evt('win-total-ladder', [
  mkt('wins-10plus', 0.88, 0.92),
  mkt('wins-11plus', 0.78, 0.82),
  mkt('wins-12plus', 0.68, 0.72),
]);

describe('scanEvent', () => {
  it('(a) flags a long edge on an underpriced partition and nets out taker fees', () => {
    const groups = scanEvent(longEvent);
    expect(groups).toHaveLength(1);
    const g = groups[0];

    expect(g.complete).toBe(true);
    expect(g.legCount).toBe(3);
    expect(g.sumAsk).toBeCloseTo(0.97, 12);
    expect(g.sumBid).toBeCloseTo(0.94, 12);
    expect(g.sumMid).toBeCloseTo(0.955, 12);
    expect(g.kind).toBe('long');

    expect(g.longEdgeGross).toBeCloseTo(0.03, 12);
    const expectedLongNet = 0.03 - LONG_ASKS.reduce((s, p) => s + fee(p), 0);
    expect(g.longEdgeNet).toBeCloseTo(expectedLongNet, 9);
    expect(g.longEdgeNet).toBeGreaterThan(0);

    // Selling every leg at bid receives 0.94 and owes $1 → gross -0.06.
    expect(g.shortEdgeGross).toBeCloseTo(-0.06, 12);
    expect(g.shortEdgeNet).toBeLessThan(0);
  });

  it('(b) flags a short edge when bids sum above $1', () => {
    const groups = scanEvent(shortEvent);
    expect(groups).toHaveLength(1);
    const g = groups[0];

    expect(g.complete).toBe(true);
    expect(g.sumBid).toBeCloseTo(1.05, 12);
    expect(g.kind).toBe('short');
    expect(g.longEdgeNet).toBeLessThan(0); // Σask = 1.05, buying all legs loses money

    expect(g.shortEdgeGross).toBeCloseTo(0.05, 12);
    const expectedShortNet = 0.05 - SHORT_BIDS.reduce((s, p) => s + fee(p), 0);
    expect(g.shortEdgeNet).toBeCloseTo(expectedShortNet, 9);
    expect(g.shortEdgeNet).toBeGreaterThan(0);
  });

  it('(c) still returns a non-partition ladder from scanEvent, with kind none', () => {
    const groups = scanEvent(ladderEvent);
    expect(groups).toHaveLength(1);
    const g = groups[0];

    expect(g.sumMid).toBeCloseTo(2.4, 12);
    expect(g.kind).toBe('none');
    // partitionScore = max(0, 1 - |1 - 2.4|) = 0.
    expect(g.partitionScore).toBe(0);
  });

  it('scores a perfect partition (Σmid == 1) at exactly 1', () => {
    const ev = evt('perfect', [mkt('p-a', 0.59, 0.61), mkt('p-b', 0.39, 0.41)]);
    const [g] = scanEvent(ev);
    expect(g.sumMid).toBeCloseTo(1, 12);
    expect(g.partitionScore).toBeCloseTo(1, 12);
  });

  it('(e) marks a group incomplete when a leg is missing its bid quote', () => {
    const ev = evt('incomplete', [
      mkt('inc-a', 0.55, 0.57),
      mkt('inc-b', undefined, 0.4), // no bestBidQuote
    ]);
    const [g] = scanEvent(ev);
    expect(g.complete).toBe(false);
    expect(g.legs.find((l) => l.marketSlug === 'inc-b')?.bid).toBeUndefined();
    // The bid-less leg falls back to ask for its mid and contributes 0 fee at bid.
    expect(g.legs.find((l) => l.marketSlug === 'inc-b')?.mid).toBeCloseTo(0.4, 12);
    expect(g.legs.find((l) => l.marketSlug === 'inc-b')?.feeAtBid).toBe(0);
  });
});

describe('groupsForEvent', () => {
  it('(d) splits markets by marketGroups: 4 markets in 2 groups of 2', () => {
    const markets = [
      mkt('g-a', 0.48, 0.52),
      mkt('g-b', 0.46, 0.5),
      mkt('g-c', 0.28, 0.32),
      mkt('g-d', 0.66, 0.7),
    ];
    const ev = evt('grouped', markets, {
      marketGroups: [
        { id: 'grp1', title: 'First matchup', marketIds: ['g-a', 'g-b'] },
        { id: 'grp2', title: 'Second matchup', marketIds: ['g-c', 'g-d'] },
      ],
    });

    const groups = groupsForEvent(ev);
    expect(groups).toHaveLength(2);
    expect(groups[0].title).toBe('First matchup');
    expect(groups[0].markets.map((m) => m.slug)).toEqual(['g-a', 'g-b']);
    expect(groups[1].title).toBe('Second matchup');
    expect(groups[1].markets.map((m) => m.slug)).toEqual(['g-c', 'g-d']);

    // scanEvent emits one ScanGroup per market group.
    expect(scanEvent(ev)).toHaveLength(2);
  });

  it('falls back to one all-markets group when no marketGroups, skipping non-tradable markets', () => {
    const ev = evt('fallback', [
      mkt('f-a', 0.5, 0.52),
      mkt('f-b', 0.44, 0.46),
      mkt('f-hidden', 0.01, 0.02, { hidden: true }),
      mkt('f-closed', 0.01, 0.02, { closed: true }),
    ]);
    const groups = groupsForEvent(ev);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe(ev.title);
    expect(groups[0].markets.map((m) => m.slug)).toEqual(['f-a', 'f-b']);
  });

  it('returns nothing for events with fewer than two tradable markets', () => {
    expect(groupsForEvent(evt('solo', [mkt('s-a', 0.5, 0.52)]))).toEqual([]);
  });
});

describe('scanUniverse', () => {
  it('(c) drops the sumMid=2.4 ladder via the partition gate, even with includeAll', () => {
    const out = scanUniverse([ladderEvent], { includeAll: true });
    expect(out).toEqual([]);
  });

  it('(e) excludes incomplete groups with no actionable side; a missing bid does not block a long flag', () => {
    // Missing bid AND asks too expensive to buy → nothing actionable → dropped.
    const dead = evt('incomplete-universe', [
      mkt('iu-a', 0.55, 0.57),
      mkt('iu-b', undefined, 0.45),
    ]);
    expect(scanUniverse([dead], { includeAll: true })).toEqual([]);

    // Missing bid but every ask present and Σask cheap enough → long flag.
    const oneSidedLong = evt('one-sided-long', [
      mkt('os-a', 0.55, 0.56),
      mkt('os-b', undefined, 0.4),
    ]);
    const out = scanUniverse([oneSidedLong], { includeAll: true });
    expect(out).toHaveLength(1);
    expect(out[0].complete).toBe(false);
    expect(out[0].kind).toBe('long');
    expect(out[0].longEdgeNet).toBeGreaterThan(0);
    expect(out[0].shortEdgeNet).toBe(-1); // sentinel: short side unusable
  });

  it('(f) sorts results by best net edge, descending', () => {
    // Weaker long edge: Σask = 0.98 → net ≈ 0.0132.
    const weakerLong = evt('weaker-long', [
      mkt('wl-a', 0.91, 0.93),
      mkt('wl-b', 0.02, 0.03),
      mkt('wl-c', 0.01, 0.02),
    ]);

    // shortEvent net ≈ 0.0415 > longEvent net ≈ 0.0206 > weakerLong net ≈ 0.0132.
    const out = scanUniverse([weakerLong, longEvent, shortEvent]);
    expect(out.map((g) => g.eventSlug)).toEqual([
      'short-partition',
      'long-partition',
      'weaker-long',
    ]);
    const bestEdge = (g: (typeof out)[number]) => Math.max(g.longEdgeNet, g.shortEdgeNet);
    expect(bestEdge(out[0])).toBeGreaterThan(bestEdge(out[1]));
    expect(bestEdge(out[1])).toBeGreaterThan(bestEdge(out[2]));
  });

  it('filters kind=none groups unless includeAll is set', () => {
    // Balanced partition with no edge either way: Σask = 1.04, Σbid = 0.96.
    const noEdge = evt('no-edge', [mkt('ne-a', 0.58, 0.62), mkt('ne-b', 0.38, 0.42)]);
    expect(scanUniverse([noEdge])).toEqual([]);
    const withAll = scanUniverse([noEdge], { includeAll: true });
    expect(withAll).toHaveLength(1);
    expect(withAll[0].kind).toBe('none');
  });
});
