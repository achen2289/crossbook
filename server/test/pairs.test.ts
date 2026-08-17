import { describe, expect, it } from 'vitest';
import {
  buildPairs,
  curatedTitleSimilarity,
  pairId,
  sortPairs,
} from '../src/analysis/pairs.js';
import type { ArbQuote, PairQuote } from '../src/analysis/pairs.js';
import type { PmEvent, PmMarket, Quote } from '../src/pmus/types.js';
import type { KalshiEvent, KalshiMarket } from '../src/kalshi/client.js';

// ---------------------------------------------------------------- fixtures

const quote = (v: number): Quote => ({ value: String(v), currency: 'USD' });

function pmMkt(
  slug: string,
  titleShort: string,
  bid?: number,
  ask?: number,
  extra?: Partial<PmMarket>,
): PmMarket {
  return {
    id: slug,
    slug,
    titleShort,
    bestBidQuote: bid !== undefined ? quote(bid) : undefined,
    bestAskQuote: ask !== undefined ? quote(ask) : undefined,
    ...extra,
  };
}

function pmEv(slug: string, title: string, markets: PmMarket[], extra?: Partial<PmEvent>): PmEvent {
  return { id: slug, slug, title, markets, ...extra };
}

function kMkt(
  ticker: string,
  eventTicker: string,
  outcome: string,
  q: { yesBid?: number; yesAsk?: number; noBid?: number; noAsk?: number },
): KalshiMarket {
  return { ticker, eventTicker, title: outcome, outcome, ...q };
}

const kEv = (eventTicker: string, title: string, markets: KalshiMarket[]): KalshiEvent => ({
  eventTicker,
  title,
  markets,
});

// Mirror of the venue fee formulas so expected edges are spelled out in full.
const pmFee = (p: number, theta = 0.06) => theta * p * (1 - p);
const kFee = (p: number) => Math.ceil(0.07 * p * (1 - p) * 100) / 100;

/** Curated fixture: venue event titles share no tokens, so nothing here can
 * come from the auto-matcher — every pair must be curated-built. */
const pmFed = pmEv('fed-sept', 'Fed decision September', [
  pmMkt('pm-fed-hike', 'Hike', 0.55, 0.57),
]);
const kFed = kEv('KXFED', 'Target rate outcome', [
  kMkt('KXFED-H', 'KXFED', 'Hike', { yesBid: 0.59, yesAsk: 0.61, noBid: 0.39, noAsk: 0.41 }),
]);
const fedCurated = [{ pmSlug: 'pm-fed-hike', kalshiTicker: 'KXFED-H' }];

/** Auto-match fixture: identical event titles and identical outcome titles
 * score eventScore = 1, outcomeScore = 1 -> high trust. */
const pmGdp = pmEv('gdp-event', 'US GDP growth above 3 percent in Q3', [
  pmMkt('gdp-above-3', 'Above 3 percent', 0.4, 0.42),
]);
const kGdp = kEv('KXGDP', 'US GDP growth above 3 percent in Q3', [
  kMkt('KXGDP-A3', 'KXGDP', 'Above 3 percent', {
    yesBid: 0.44,
    yesAsk: 0.46,
    noBid: 0.54,
    noAsk: 0.56,
  }),
]);

describe('pairId', () => {
  it('joins slug and ticker with a double underscore', () => {
    expect(pairId('some-slug', 'KXTICK-24')).toBe('some-slug__KXTICK-24');
  });
});

describe('buildPairs — curated pairs', () => {
  it('builds a curated pair with exact edge math, including the ceil-rounded Kalshi fee', () => {
    const pairs = buildPairs([pmFed], [kFed], fedCurated);
    expect(pairs).toHaveLength(1);
    const p = pairs[0];

    expect(p.id).toBe('pm-fed-hike__KXFED-H');
    expect(p.curated).toBe(true);
    expect(p.trust).toBe('curated');
    expect(p.confidence).toBe(1);
    expect(p.suspect).toBe(false);
    expect(p.live).toBeUndefined();

    expect(p.pm).toMatchObject({ slug: 'pm-fed-hike', title: 'Hike', eventSlug: 'fed-sept' });
    expect(p.pm.yesBid).toBe(0.55);
    expect(p.pm.yesAsk).toBe(0.57);
    expect(p.pm.mid).toBeCloseTo(0.56, 9);
    expect(p.kalshi).toMatchObject({ ticker: 'KXFED-H', outcome: 'Hike', eventTicker: 'KXFED' });
    expect(p.kalshi.mid).toBeCloseTo(0.6, 9);
    expect(p.gap).toBeCloseTo(-0.04, 9);

    // Strategy A: PM YES @ 0.57 ask + Kalshi NO @ 0.41 ask.
    // Kalshi fee on 0.41 unrounded is 1.6933 cents; billed as 2 cents.
    expect(kFee(0.41)).toBe(0.02);
    expect(kFee(0.41)).toBeGreaterThan(0.07 * 0.41 * 0.59);
    const edgeA = 1 - (0.57 + pmFee(0.57) + 0.41 + kFee(0.41));
    expect(edgeA).toBeCloseTo(-0.014706, 9);
    expect(p.arb.edgeA).toBeCloseTo(edgeA, 9);
    expect(p.arb.legsA).toEqual([
      { venue: 'polymarket', side: 'YES', price: 0.57, fee: pmFee(0.57) },
      { venue: 'kalshi', side: 'NO', price: 0.41, fee: 0.02 },
    ]);

    // Strategy B: Kalshi YES @ 0.61 ask + PM NO @ (1 - 0.55 yes bid).
    const pmNoAsk = 1 - 0.55;
    const edgeB = 1 - (0.61 + kFee(0.61) + pmNoAsk + pmFee(pmNoAsk));
    expect(edgeB).toBeCloseTo(-0.09485, 9);
    expect(p.arb.edgeB).toBeCloseTo(edgeB, 9);
    expect(p.arb.legsB![0]).toEqual({ venue: 'kalshi', side: 'YES', price: 0.61, fee: 0.02 });
    expect(p.arb.legsB![1].venue).toBe('polymarket');
    expect(p.arb.legsB![1].side).toBe('NO');
    expect(p.arb.legsB![1].price).toBeCloseTo(0.45, 9);

    // A loses less than B here, so A is the best strategy.
    expect(p.arb.best).toBe('A');
    expect(p.arb.bestEdge).toBe(p.arb.edgeA);
  });

  it('routes the per-market feeCoefficient into the PM legs', () => {
    const cheap = pmEv('fed-sept', 'Fed decision September', [
      pmMkt('pm-fed-hike', 'Hike', 0.55, 0.57, { feeCoefficient: 0.02 }),
    ]);
    const [p] = buildPairs([cheap], [kFed], fedCurated);
    expect(p.pm.feeCoefficient).toBe(0.02);
    expect(p.arb.legsA![0].fee).toBeCloseTo(pmFee(0.57, 0.02), 12);
    expect(p.arb.edgeA).toBeCloseTo(1 - (0.57 + pmFee(0.57, 0.02) + 0.41 + kFee(0.41)), 9);
  });

  it('selects strategy B when Kalshi YES + PM NO is the better lock', () => {
    const pm = pmEv('b-event', 'Completely unrelated topic alpha', [
      pmMkt('pm-b', 'Outcome', 0.7, 0.72),
    ]);
    const k = kEv('KXB', 'Different words entirely beta', [
      kMkt('KXB-1', 'KXB', 'Outcome', { yesBid: 0.55, yesAsk: 0.6, noBid: 0.4, noAsk: 0.42 }),
    ]);
    const [p] = buildPairs([pm], [k], [{ pmSlug: 'pm-b', kalshiTicker: 'KXB-1' }]);

    const edgeA = 1 - (0.72 + pmFee(0.72) + 0.42 + kFee(0.42));
    const pmNoAsk = 1 - 0.7;
    const edgeB = 1 - (0.6 + kFee(0.6) + pmNoAsk + pmFee(pmNoAsk));
    expect(edgeA).toBeLessThan(0);
    expect(edgeB).toBeCloseTo(0.0674, 9);

    expect(p.arb.edgeA).toBeCloseTo(edgeA, 9);
    expect(p.arb.edgeB).toBeCloseTo(edgeB, 9);
    expect(p.arb.best).toBe('B');
    expect(p.arb.bestEdge).toBe(p.arb.edgeB);
    expect(p.arb.legsB![0]).toEqual({ venue: 'kalshi', side: 'YES', price: 0.6, fee: 0.02 });
  });

  it('computes only the strategies whose legs have quotes', () => {
    const kNoNoAsk = kEv('KXFED', 'Target rate outcome', [
      kMkt('KXFED-H', 'KXFED', 'Hike', { yesBid: 0.59, yesAsk: 0.61, noBid: 0.39 }),
    ]);
    const [p] = buildPairs([pmFed], [kNoNoAsk], fedCurated);
    expect(p.arb.edgeA).toBeUndefined();
    expect(p.arb.legsA).toBeUndefined();
    expect(p.arb.edgeB).toBeDefined();
    expect(p.arb.best).toBe('B');
    expect(p.arb.bestEdge).toBe(p.arb.edgeB);
  });

  it('drops curated entries whose PM or Kalshi side is missing, without consuming the market', () => {
    const pairs = buildPairs(
      [pmGdp],
      [kGdp],
      [
        { pmSlug: 'no-such-slug', kalshiTicker: 'KXGDP-A3' },
        { pmSlug: 'gdp-above-3', kalshiTicker: 'NO-SUCH-TICKER' },
      ],
    );
    // Both curated entries are silently dropped; since a dropped entry does
    // not consume the market, the auto-matcher still pairs the two sides.
    expect(pairs).toHaveLength(1);
    expect(pairs[0].curated).toBe(false);
    expect(pairs[0].trust).toBe('high');
  });

  it('drops curated entries pointing at a closed or inactive PM market', () => {
    const closed = pmEv('fed-sept', 'Fed decision September', [
      pmMkt('pm-fed-hike', 'Hike', 0.55, 0.57, { closed: true }),
    ]);
    expect(buildPairs([closed], [kFed], fedCurated)).toHaveLength(0);

    const inactive = pmEv('fed-sept', 'Fed decision September', [
      pmMkt('pm-fed-hike', 'Hike', 0.55, 0.57, { active: false }),
    ]);
    expect(buildPairs([inactive], [kFed], fedCurated)).toHaveLength(0);
  });

  it('curated consumes the market, so the auto-matcher emits no duplicate pair', () => {
    // pmGdp/kGdp would auto-match at eventScore 1 / outcomeScore 1; with a
    // curated mapping in place, exactly one pair exists and it is curated.
    const pairs = buildPairs(
      [pmGdp],
      [kGdp],
      [{ pmSlug: 'gdp-above-3', kalshiTicker: 'KXGDP-A3' }],
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0].curated).toBe(true);
    expect(pairs[0].trust).toBe('curated');
    expect(pairs[0].confidence).toBe(1);
  });

  it('propagates the PM live flag', () => {
    const livePm = pmEv('fed-sept', 'Fed decision September', [
      pmMkt('pm-fed-hike', 'Hike', 0.55, 0.57),
    ], { live: true });
    const [p] = buildPairs([livePm], [kFed], fedCurated);
    expect(p.live).toBe(true);
  });
});

describe('buildPairs — trust tiers from the auto-matcher', () => {
  it('grants high trust when eventScore >= 0.65 and outcomeScore >= 0.5, and computes edges', () => {
    const [p] = buildPairs([pmGdp], [kGdp], []);
    expect(p.trust).toBe('high');
    expect(p.curated).toBe(false);
    expect(p.confidence).toBe(1); // identical titles both levels
    expect(p.suspect).toBe(false);
    expect(p.arb.edgeA).toBeCloseTo(1 - (0.42 + pmFee(0.42) + 0.56 + kFee(0.56)), 9);
    expect(p.arb.bestEdge).toBeLessThan(0);
  });

  it('grants low trust when the outcome score is below 0.5', () => {
    // Identical event titles (score 1) but outcomes overlap at jaccard 2/5.
    const pm = pmEv('nba-event', 'NBA Finals champion 2027', [
      pmMkt('warriors-title', 'Warriors title favorites', 0.3, 0.32),
    ]);
    const k = kEv('KXNBA', 'NBA Finals champion 2027', [
      kMkt('KXNBA-GSW', 'KXNBA', 'Warriors title contender odds', {
        yesBid: 0.28,
        yesAsk: 0.3,
        noBid: 0.7,
        noAsk: 0.72,
      }),
    ]);
    const [p] = buildPairs([pm], [k], []);
    expect(p.trust).toBe('low');
    expect(p.confidence).toBeCloseTo(0.4, 12);
    expect(p.suspect).toBe(false); // gap 0.02 is under every threshold
    expect(p.gap).toBeCloseTo(0.02, 9);
  });

  it('grants low trust when the event score is below 0.65 even with identical outcomes', () => {
    // Event titles share {bitcoin, price, above, 100k}: jaccard 4/8 = 0.5.
    const pm = pmEv('btc-event', 'Bitcoin price above 100k by March', [
      pmMkt('btc-100k', 'Above 100k', 0.5, 0.52),
    ]);
    const k = kEv('KXBTC', 'Bitcoin price above 100k threshold official close', [
      kMkt('KXBTC-1', 'KXBTC', 'Above 100k', { yesBid: 0.49, yesAsk: 0.51, noBid: 0.49, noAsk: 0.51 }),
    ]);
    const [p] = buildPairs([pm], [k], []);
    expect(p.trust).toBe('low');
    expect(p.confidence).toBeCloseTo(0.5, 12);
  });

  it('gives low-trust pairs an empty arb object — gap only, no edges', () => {
    const pm = pmEv('nba-event', 'NBA Finals champion 2027', [
      pmMkt('warriors-title', 'Warriors title favorites', 0.3, 0.32),
    ]);
    const k = kEv('KXNBA', 'NBA Finals champion 2027', [
      kMkt('KXNBA-GSW', 'KXNBA', 'Warriors title contender odds', {
        yesBid: 0.28,
        yesAsk: 0.3,
        noBid: 0.7,
        noAsk: 0.72,
      }),
    ]);
    const [p] = buildPairs([pm], [k], []);
    expect(p.arb).toEqual({});
  });
});

describe('buildPairs — suspect flag', () => {
  it('marks a non-curated pair suspect when the best edge exceeds 8 cents, even with a modest gap', () => {
    const pm = pmEv('cpi-event', 'CPI above 4 percent in May', [
      pmMkt('cpi-above-4', 'Above 4 percent', 0.28, 0.3),
    ]);
    const k = kEv('KXCPI', 'CPI above 4 percent in May', [
      kMkt('KXCPI-A4', 'KXCPI', 'Above 4 percent', {
        yesBid: 0.48,
        yesAsk: 0.52,
        noBid: 0.48,
        noAsk: 0.5,
      }),
    ]);
    const [p] = buildPairs([pm], [k], []);
    expect(p.trust).toBe('high');
    const edgeA = 1 - (0.3 + pmFee(0.3) + 0.5 + kFee(0.5));
    expect(p.arb.bestEdge).toBeCloseTo(edgeA, 9);
    expect(p.arb.bestEdge!).toBeGreaterThan(0.08); // 0.1674
    expect(Math.abs(p.gap!)).toBeLessThan(0.25); // 0.21 — gap rule alone would NOT fire
    expect(p.suspect).toBe(true);
  });

  it('applies the gap threshold by tier: |gap| = 0.20 passes at high trust but is suspect at low trust', () => {
    // Same quotes both times: PM mid 0.50 vs Kalshi mid 0.70 (gap -0.20).
    // The Kalshi NO side is unquoted, so strategy A cannot be priced, and
    // strategy B (buy the already-expensive Kalshi YES) is deeply negative —
    // only the gap rule can decide.
    const q = { yesBid: 0.69, yesAsk: 0.71 };

    const pmHigh = pmEv('senate-event', 'Senate control party', [
      pmMkt('senate-rep', 'Republicans', 0.49, 0.51),
    ]);
    const kHigh = kEv('KXSEN', 'Senate control party', [
      kMkt('KXSEN-R', 'KXSEN', 'Republicans', q),
    ]);
    const [high] = buildPairs([pmHigh], [kHigh], []);
    expect(high.trust).toBe('high');
    expect(high.gap).toBeCloseTo(-0.2, 9);
    expect(high.arb.edgeA).toBeUndefined();
    expect(high.arb.bestEdge!).toBeLessThan(0); // edge rule cannot be the cause
    expect(high.suspect).toBe(false); // |−0.20| <= 0.25

    const pmLow = pmEv('nba-event', 'NBA Finals champion 2027', [
      pmMkt('warriors-title', 'Warriors title favorites', 0.49, 0.51),
    ]);
    const kLow = kEv('KXNBA', 'NBA Finals champion 2027', [
      kMkt('KXNBA-GSW', 'KXNBA', 'Warriors title contender odds', q),
    ]);
    const [low] = buildPairs([pmLow], [kLow], []);
    expect(low.trust).toBe('low');
    expect(low.gap).toBeCloseTo(-0.2, 9);
    expect(low.suspect).toBe(true); // |−0.20| > 0.15
  });

  it('marks a high-trust pair suspect once |gap| exceeds 0.25', () => {
    // PM mid 0.50 vs Kalshi mid 0.80; NO side unquoted again, so the only
    // priceable strategy is B and it loses ~35 cents.
    const pm = pmEv('senate-event', 'Senate control party', [
      pmMkt('senate-rep', 'Republicans', 0.49, 0.51),
    ]);
    const k = kEv('KXSEN', 'Senate control party', [
      kMkt('KXSEN-R', 'KXSEN', 'Republicans', { yesBid: 0.79, yesAsk: 0.81 }),
    ]);
    const [p] = buildPairs([pm], [k], []);
    expect(p.trust).toBe('high');
    expect(p.gap).toBeCloseTo(-0.3, 9);
    expect(p.arb.edgeA).toBeUndefined();
    expect(p.arb.bestEdge).toBeCloseTo(1 - (0.81 + kFee(0.81) + (1 - 0.49) + pmFee(1 - 0.49)), 9);
    expect(p.arb.bestEdge!).toBeLessThan(0); // edge rule is not the cause
    expect(p.suspect).toBe(true);
  });

  it('never marks curated pairs suspect, however extreme the gap or edge', () => {
    const pm = pmEv('x-event', 'Some question', [pmMkt('pm-x', 'X', 0.2, 0.22)]);
    const k = kEv('KXX', 'Wholly different words', [
      kMkt('KXX-1', 'KXX', 'X', { yesBid: 0.6, yesAsk: 0.62, noBid: 0.36, noAsk: 0.38 }),
    ]);
    const [p] = buildPairs([pm], [k], [{ pmSlug: 'pm-x', kalshiTicker: 'KXX-1' }]);
    expect(p.gap).toBeCloseTo(-0.4, 9); // would trip either tier's gap rule
    expect(p.arb.bestEdge).toBeCloseTo(1 - (0.22 + pmFee(0.22) + 0.38 + kFee(0.38)), 9);
    expect(p.arb.bestEdge!).toBeGreaterThan(0.08); // would trip the edge rule
    expect(p.suspect).toBe(false);
  });
});

describe('sortPairs', () => {
  function bare(id: string, over: Partial<PairQuote> & { arb?: ArbQuote }): PairQuote {
    return {
      id,
      pm: { slug: id, title: id, eventSlug: 'e', eventTitle: 'E' },
      kalshi: { ticker: id, outcome: id, eventTicker: 'K', eventTitle: 'K' },
      curated: false,
      confidence: 1,
      trust: 'high',
      suspect: false,
      arb: {},
      ...over,
    };
  }

  it('orders: positive edges (live demoted a tier), then |gap| with phantoms, suspects last', () => {
    const suspect = bare('suspect', { suspect: true, gap: 0.5 });
    const posSmall = bare('pos-small', { arb: { best: 'A', bestEdge: 0.01 }, gap: 0.01 });
    const posBig = bare('pos-big', {
      arb: { best: 'A', bestEdge: 0.02, executableSets: 3 },
      refreshed: true,
      gap: 0.01,
    });
    const livePos = bare('live-pos', { arb: { best: 'A', bestEdge: 0.03 }, live: true, gap: 0.01 });
    const phantom = bare('phantom', {
      arb: { best: 'A', bestEdge: 0.05, executableSets: 0 },
      refreshed: true,
      gap: 0.02,
    });
    const negEdge = bare('neg-edge', { arb: { best: 'A', bestEdge: -0.05 }, gap: 0.06 });
    const diverge = bare('diverge', { gap: -0.1 });

    const pairs = [suspect, phantom, diverge, livePos, negEdge, posSmall, posBig];
    sortPairs(pairs);
    expect(pairs.map((p) => p.id)).toEqual([
      'pos-big', // 0.02 edge, refreshed with size behind it — top tier
      'pos-small', // 0.01 edge — still above every live/divergence pair
      'live-pos', // bigger edge (0.03) but in-play: one tier down
      'diverge', // no edge: ranked by |gap| = 0.10
      'neg-edge', // negative edge falls back to |gap| = 0.06
      'phantom', // 5 cent "edge" on an empty book: demoted to |gap| = 0.02
      'suspect', // always last
    ]);
  });

  it('is stable against missing gap/edge fields', () => {
    const empty = bare('empty', {});
    const gapped = bare('gapped', { gap: 0.05 });
    const pairs = [empty, gapped];
    sortPairs(pairs);
    expect(pairs.map((p) => p.id)).toEqual(['gapped', 'empty']);
  });
});

describe('curatedTitleSimilarity', () => {
  it('scores synonym-equivalent titles at 1', () => {
    expect(curatedTitleSimilarity('Hike 25 bps', '25 bps increase')).toBe(1);
  });

  it('zeroes the score when numeric tokens disagree', () => {
    expect(curatedTitleSimilarity('Above 3', 'Above 4')).toBe(0);
  });
});
