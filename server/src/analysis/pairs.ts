import { kalshiTakerFee, pmTakerFee } from './fees.js';
import { jaccard, matchVenues, numericAgreement, tokenize } from './matcher.js';
import { quotePx } from '../pmus/types.js';
import type { PmEvent, PmMarket } from '../pmus/types.js';
import type { PmusClient } from '../pmus/client.js';
import type { KalshiClient, KalshiEvent, KalshiMarket } from '../kalshi/client.js';

export interface CuratedPair {
  pmSlug: string;
  kalshiTicker: string;
  note?: string;
}

export interface ArbLeg {
  venue: 'polymarket' | 'kalshi';
  side: 'YES' | 'NO';
  price: number;
  fee: number;
}

/**
 * Two ways to lock in $1 across venues (per contract set):
 *   A: buy YES on Polymarket + buy NO on Kalshi  — pays when Kalshi prices
 *      the outcome ABOVE Polymarket (edgeA ≈ kYesBid − pmYesAsk − fees)
 *   B: buy YES on Kalshi + buy NO on Polymarket  — the reverse.
 * Polymarket runs a single YES book, so buying NO there executes against
 * the YES bid at price (1 − yesBid).
 */
export interface ArbQuote {
  edgeA?: number;
  edgeB?: number;
  legsA?: ArbLeg[];
  legsB?: ArbLeg[];
  best?: 'A' | 'B';
  bestEdge?: number;
  /** Complete sets fillable at top-of-book for the best strategy (enriched). */
  executableSets?: number;
}

export interface PairQuote {
  id: string;
  pm: {
    slug: string;
    title: string;
    eventSlug: string;
    eventTitle: string;
    yesBid?: number;
    yesAsk?: number;
    mid?: number;
    feeCoefficient?: number;
  };
  kalshi: {
    ticker: string;
    outcome: string;
    eventTicker: string;
    eventTitle: string;
    yesBid?: number;
    yesAsk?: number;
    noBid?: number;
    noAsk?: number;
    mid?: number;
  };
  curated: boolean;
  confidence: number;
  /**
   * How much to believe the two contracts are the same question:
   *   curated — hand-verified slug↔ticker mapping
   *   high    — near-exact title match on event AND outcome
   *   low     — loose fuzzy match: gap shown for review, but NO arb math.
   * Between two regulated venues a genuine riskless edge is a few cents;
   * a "20¢ arb" is almost always a unit or deadline mismatch (CPI YoY vs
   * MoM, end-of-year vs end-of-month), so low-trust pairs never get one.
   */
  trust: 'curated' | 'high' | 'low';
  suspect: boolean;
  /** In-play event on the Polymarket side: quotes move second to second,
   * so an apparent cross-venue edge is usually staleness, not money. */
  live?: boolean;
  /** pmMid − kalshiMid, dollars. Positive = Polymarket prices it higher. */
  gap?: number;
  arb: ArbQuote;
  /** True once quotes and edges were re-derived from live order books. */
  refreshed?: boolean;
}

const HIGH_TRUST_EVENT_SCORE = 0.65;
const HIGH_TRUST_OUTCOME_SCORE = 0.5;
const SUSPECT_GAP_AUTO = 0.15;
const SUSPECT_GAP_HIGH = 0.25;
// Between two regulated venues, a genuine riskless edge is cents. A fuzzy-
// matched pair showing 8¢+ is nearly always a question mismatch the title
// comparison can't see (CPI YoY vs MoM, release month vs data month).
const SUSPECT_EDGE_NON_CURATED = 0.08;

export const pairId = (pmSlug: string, kTicker: string): string => `${pmSlug}__${kTicker}`;

function computeArb(
  pm: { yesBid?: number; yesAsk?: number },
  k: { yesAsk?: number; noAsk?: number },
  pmTheta?: number,
): ArbQuote {
  const arb: ArbQuote = {};
  if (pm.yesAsk !== undefined && k.noAsk !== undefined) {
    const legs: ArbLeg[] = [
      { venue: 'polymarket', side: 'YES', price: pm.yesAsk, fee: pmTakerFee(pm.yesAsk, pmTheta) },
      { venue: 'kalshi', side: 'NO', price: k.noAsk, fee: kalshiTakerFee(k.noAsk) },
    ];
    arb.legsA = legs;
    arb.edgeA = 1 - legs.reduce((s, l) => s + l.price + l.fee, 0);
  }
  if (pm.yesBid !== undefined && k.yesAsk !== undefined) {
    const pmNoAsk = 1 - pm.yesBid;
    const legs: ArbLeg[] = [
      { venue: 'kalshi', side: 'YES', price: k.yesAsk, fee: kalshiTakerFee(k.yesAsk) },
      { venue: 'polymarket', side: 'NO', price: pmNoAsk, fee: pmTakerFee(pmNoAsk, pmTheta) },
    ];
    arb.legsB = legs;
    arb.edgeB = 1 - legs.reduce((s, l) => s + l.price + l.fee, 0);
  }
  if (arb.edgeA !== undefined || arb.edgeB !== undefined) {
    arb.best = (arb.edgeA ?? -Infinity) >= (arb.edgeB ?? -Infinity) ? 'A' : 'B';
    arb.bestEdge = arb.best === 'A' ? arb.edgeA : arb.edgeB;
  }
  return arb;
}

const mid = (bid?: number, ask?: number): number | undefined =>
  bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined;

function buildPair(
  pmMarket: PmMarket,
  pmEvent: { slug: string; title: string; live?: boolean },
  kMarket: KalshiMarket,
  kEventTitle: string,
  trust: PairQuote['trust'],
  confidence: number,
): PairQuote {
  const curated = trust === 'curated';
  const pmYesBid = quotePx(pmMarket.bestBidQuote);
  const pmYesAsk = quotePx(pmMarket.bestAskQuote);
  const pmMid = mid(pmYesBid, pmYesAsk);
  const kMid = mid(kMarket.yesBid, kMarket.yesAsk);
  const gap = pmMid !== undefined && kMid !== undefined ? pmMid - kMid : undefined;
  const arb =
    trust === 'low'
      ? {}
      : computeArb(
          { yesBid: pmYesBid, yesAsk: pmYesAsk },
          { yesAsk: kMarket.yesAsk, noAsk: kMarket.noAsk },
          pmMarket.feeCoefficient,
        );
  const suspect = curated
    ? false
    : (gap !== undefined &&
        Math.abs(gap) > (trust === 'high' ? SUSPECT_GAP_HIGH : SUSPECT_GAP_AUTO)) ||
      (arb.bestEdge ?? 0) > SUSPECT_EDGE_NON_CURATED;
  return {
    id: pairId(pmMarket.slug, kMarket.ticker),
    pm: {
      slug: pmMarket.slug,
      title: pmMarket.titleShort || pmMarket.title || pmMarket.question || pmMarket.slug,
      eventSlug: pmEvent.slug,
      eventTitle: pmEvent.title,
      yesBid: pmYesBid,
      yesAsk: pmYesAsk,
      mid: pmMid,
      feeCoefficient: pmMarket.feeCoefficient,
    },
    kalshi: {
      ticker: kMarket.ticker,
      outcome: kMarket.outcome,
      eventTicker: kMarket.eventTicker,
      eventTitle: kEventTitle,
      yesBid: kMarket.yesBid,
      yesAsk: kMarket.yesAsk,
      noBid: kMarket.noBid,
      noAsk: kMarket.noAsk,
      mid: kMid,
    },
    curated,
    confidence,
    trust,
    suspect,
    live: pmEvent.live || undefined,
    gap,
    arb,
  };
}

/**
 * Curated pairs are hand-verified slug↔ticker mappings and rank first;
 * everything else comes from the fuzzy title matcher as a review queue.
 */
export function buildPairs(
  pmEvents: PmEvent[],
  kEvents: KalshiEvent[],
  curated: CuratedPair[],
): PairQuote[] {
  const pmBySlug = new Map<string, { market: PmMarket; event: PmEvent }>();
  for (const ev of pmEvents) {
    for (const m of ev.markets ?? []) {
      if (m.active !== false && m.closed !== true) pmBySlug.set(m.slug, { market: m, event: ev });
    }
  }
  const kByTicker = new Map<string, { market: KalshiMarket; event: KalshiEvent }>();
  for (const ev of kEvents) {
    for (const m of ev.markets) kByTicker.set(m.ticker, { market: m, event: ev });
  }

  const pairs: PairQuote[] = [];
  const used = new Set<string>();

  for (const c of curated) {
    const pm = pmBySlug.get(c.pmSlug);
    const k = kByTicker.get(c.kalshiTicker);
    if (!pm || !k) continue; // one side closed/expired — drop silently
    pairs.push(buildPair(pm.market, pm.event, k.market, k.event.title, 'curated', 1));
    used.add(c.pmSlug);
    used.add(c.kalshiTicker);
  }

  for (const m of matchVenues(pmEvents, kEvents)) {
    if (used.has(m.pm.id) || used.has(m.kalshi.id)) continue;
    const pm = pmBySlug.get(m.pm.id);
    const k = kByTicker.get(m.kalshi.id);
    if (!pm || !k) continue;
    used.add(m.pm.id);
    used.add(m.kalshi.id);
    const trust =
      m.eventScore >= HIGH_TRUST_EVENT_SCORE && m.outcomeScore >= HIGH_TRUST_OUTCOME_SCORE
        ? 'high'
        : 'low';
    pairs.push(buildPair(pm.market, pm.event, k.market, k.event.title, trust, m.confidence));
  }

  sortPairs(pairs);
  return pairs;
}

/**
 * Suspects last. Actionable = positive edge with someone actually on the
 * other side (executableSets 0 after a book check = phantom edge on an
 * empty book). In-play pairs rank below settled-pace ones — their "edges"
 * are usually two venues ticking at different speeds. Pure divergences
 * rank by |gap|.
 */
export function sortPairs(pairs: PairQuote[]): void {
  const rank = (p: PairQuote): number => {
    if (p.suspect) return -1;
    const edge = p.arb.bestEdge;
    const phantom = p.refreshed && (p.arb.executableSets ?? 0) === 0;
    if (edge !== undefined && edge > 0 && !phantom) {
      return (p.live ? 1000 : 2000) + edge;
    }
    return Math.abs(p.gap ?? 0);
  };
  pairs.sort((a, b) => rank(b) - rank(a));
}

/** Sanity-score a curated candidate so typos in the mapping surface early. */
export function curatedTitleSimilarity(pmTitle: string, kOutcome: string): number {
  const a = tokenize(pmTitle);
  const b = tokenize(kOutcome);
  return jaccard(a, b) * numericAgreement(a, b);
}

/**
 * Re-price a pair from live order books and attach executable size.
 * The event-embedded quotes on both venues lag their matching engines, so
 * anything presented as an actionable edge goes through this first.
 *
 * Kalshi's book lists resting bids per side: buying YES fills against the
 * best NO bid (yesAsk = 1 − noBid) and buying NO fills against the best
 * YES bid, so each strategy's size is capped by the opposite side's level.
 */
export async function computeExecutable(
  pair: PairQuote,
  pmus: PmusClient,
  kalshi: KalshiClient,
): Promise<void> {
  const [pmBook, kBook] = await Promise.all([
    pmus.getMarketBook(pair.pm.slug),
    kalshi.getOrderbook(pair.kalshi.ticker),
  ]);
  const pmTop = (levels?: { px: { value: string }; qty: string }[]) => {
    const l = levels?.[0];
    return l ? { px: parseFloat(l.px.value), qty: parseFloat(l.qty) } : undefined;
  };
  const pmAsk = pmTop(pmBook.marketData.asks);
  const pmBid = pmTop(pmBook.marketData.bids);
  const kYesBid = kBook.yesBids[0];
  const kNoBid = kBook.noBids[0];

  pair.pm.yesAsk = pmAsk?.px;
  pair.pm.yesBid = pmBid?.px;
  pair.pm.mid = mid(pair.pm.yesBid, pair.pm.yesAsk);
  pair.kalshi.yesBid = kYesBid?.px;
  pair.kalshi.yesAsk = kNoBid ? 1 - kNoBid.px : undefined;
  pair.kalshi.noBid = kNoBid?.px;
  pair.kalshi.noAsk = kYesBid ? 1 - kYesBid.px : undefined;
  pair.kalshi.mid = mid(pair.kalshi.yesBid, pair.kalshi.yesAsk);
  pair.gap =
    pair.pm.mid !== undefined && pair.kalshi.mid !== undefined
      ? pair.pm.mid - pair.kalshi.mid
      : undefined;

  pair.arb = computeArb(
    { yesBid: pair.pm.yesBid, yesAsk: pair.pm.yesAsk },
    { yesAsk: pair.kalshi.yesAsk, noAsk: pair.kalshi.noAsk },
    pair.pm.feeCoefficient,
  );
  if (pair.arb.best === 'A') {
    pair.arb.executableSets =
      pmAsk && kYesBid ? Math.floor(Math.min(pmAsk.qty, kYesBid.qty)) : 0;
  } else if (pair.arb.best === 'B') {
    pair.arb.executableSets =
      pmBid && kNoBid ? Math.floor(Math.min(pmBid.qty, kNoBid.qty)) : 0;
  }
  if (pair.trust !== 'curated' && (pair.arb.bestEdge ?? 0) > SUSPECT_EDGE_NON_CURATED) {
    pair.suspect = true;
  }
  pair.refreshed = true;
}
