import { quotePx } from '../pmus/types.js';
import type { PmEvent } from '../pmus/types.js';
import type { KalshiEvent } from '../kalshi/client.js';

export interface VenueQuote {
  id: string;
  title: string;
  eventTitle: string;
  bid?: number;
  ask?: number;
  mid?: number;
}

export interface MarketMatch {
  pm: VenueQuote;
  kalshi: VenueQuote;
  eventScore: number;
  outcomeScore: number;
  confidence: number;
  /** pm.mid - kalshi.mid; positive = Polymarket prices the outcome higher. */
  divergence: number;
  /** Gaps this large are usually a semantic mismatch (different question),
   * not a real cross-venue disagreement — surfaced for review, ranked last. */
  suspect: boolean;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'by', 'to', 'for', 'and', 'or',
  'will', 'be', 'is', 'vs', 'v', 'win', 'winner', '2025', '2026', '2027',
]);

// Cross-venue vocabulary differences observed in Fed/CPI/election titles.
const SYNONYMS: Record<string, string> = {
  hike: 'increase',
  raise: 'increase',
  raised: 'increase',
  cut: 'decrease',
  lower: 'decrease',
  lowered: 'decrease',
  bps: 'bp',
  'basis-points': 'bp',
  democrat: 'democratic',
  gop: 'republican',
  'no-change': 'unchanged',
};

export function tokenize(s: string): Set<string> {
  const tokens = s
    .toLowerCase()
    .replace(/[+]/g, ' plus ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map((t) => SYNONYMS[t] ?? t);
  return new Set(tokens);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const MIN_EVENT_SCORE = 0.45;
const MIN_OUTCOME_SCORE = 0.34;
const SUSPECT_DIVERGENCE = 0.25;
// A wide spread means an empty book, and an empty book's mid is noise —
// PM bid $0 / ask $0.50 "diverging" from Kalshi bid $0 / ask $0.01 is two
// venues both saying "no market", not a 24.5¢ disagreement.
const MAX_SPREAD = 0.15;

const numericTokens = (tokens: Set<string>): Set<string> =>
  new Set([...tokens].filter((t) => /\d/.test(t)));

/**
 * Lines and thresholds must agree for two outcomes to be the same contract:
 * "New England 9.5+" (a spread) is not "New England" (a moneyline), and
 * "≥24%" is not "24". Mismatched numerics zero the match; one-sided numerics
 * halve it.
 */
export function numericAgreement(a: Set<string>, b: Set<string>): number {
  const na = numericTokens(a);
  const nb = numericTokens(b);
  if (na.size === 0 && nb.size === 0) return 1;
  if (na.size === 0 || nb.size === 0) return 0.5;
  if (na.size === nb.size && [...na].every((t) => nb.has(t))) return 1;
  return 0;
}

/**
 * Best-effort cross-venue matching by title similarity. Deliberately
 * conservative: emits a confidence score and is meant as a review queue,
 * not ground truth — venue rules for "the same" market often differ
 * (settlement source, deadline, rounding), which itself explains some gaps.
 */
export function matchVenues(pmEvents: PmEvent[], kEvents: KalshiEvent[]): MarketMatch[] {
  const kIndexed = kEvents
    .filter((e) => e.markets.length > 0)
    .map((e) => ({ event: e, tokens: tokenize(e.title) }));

  // Inverted token index: comparing every PM event against every Kalshi
  // event is ~25M jaccard calls at full-universe scale (2.6k × 9.5k) and
  // blocks the event loop for minutes. Any event pair scoring >= the
  // threshold must share at least one token, so only score those.
  const byToken = new Map<string, number[]>();
  kIndexed.forEach((k, i) => {
    for (const t of k.tokens) {
      let arr = byToken.get(t);
      if (!arr) {
        arr = [];
        byToken.set(t, arr);
      }
      arr.push(i);
    }
  });

  const matches: MarketMatch[] = [];
  for (const pmEvent of pmEvents) {
    const pmTokens = tokenize(pmEvent.title);
    const candidateIdx = new Set<number>();
    for (const t of pmTokens) {
      for (const i of byToken.get(t) ?? []) candidateIdx.add(i);
    }
    let best: { event: KalshiEvent; score: number } | undefined;
    for (const i of candidateIdx) {
      const k = kIndexed[i];
      const score = jaccard(pmTokens, k.tokens);
      if (score >= MIN_EVENT_SCORE && (!best || score > best.score)) {
        best = { event: k.event, score };
      }
    }
    if (!best) continue;

    for (const pmMarket of pmEvent.markets ?? []) {
      const pmBid = quotePx(pmMarket.bestBidQuote);
      const pmAsk = quotePx(pmMarket.bestAskQuote);
      if (pmBid === undefined || pmAsk === undefined) continue;
      if (pmAsk - pmBid > MAX_SPREAD) continue;
      const pmTitle = pmMarket.titleShort || pmMarket.title || pmMarket.question || '';
      const pmOutcomeTokens = tokenize(pmTitle);

      let bestOutcome: { m: (typeof best.event.markets)[number]; score: number } | undefined;
      for (const km of best.event.markets) {
        if (km.yesBid === undefined || km.yesAsk === undefined) continue;
        if (km.yesAsk - km.yesBid > MAX_SPREAD) continue;
        const kTokens = tokenize(km.outcome);
        const score =
          jaccard(pmOutcomeTokens, kTokens) * numericAgreement(pmOutcomeTokens, kTokens);
        if (score >= MIN_OUTCOME_SCORE && (!bestOutcome || score > bestOutcome.score)) {
          bestOutcome = { m: km, score };
        }
      }
      if (!bestOutcome) continue;

      const pmMid = (pmBid + pmAsk) / 2;
      const kMid = (bestOutcome.m.yesBid! + bestOutcome.m.yesAsk!) / 2;
      matches.push({
        pm: {
          id: pmMarket.slug,
          title: pmTitle,
          eventTitle: pmEvent.title,
          bid: pmBid,
          ask: pmAsk,
          mid: pmMid,
        },
        kalshi: {
          id: bestOutcome.m.ticker,
          title: bestOutcome.m.outcome,
          eventTitle: best.event.title,
          bid: bestOutcome.m.yesBid,
          ask: bestOutcome.m.yesAsk,
          mid: kMid,
        },
        eventScore: best.score,
        outcomeScore: bestOutcome.score,
        confidence: best.score * bestOutcome.score,
        divergence: pmMid - kMid,
        suspect: Math.abs(pmMid - kMid) > SUSPECT_DIVERGENCE,
      });
    }
  }
  matches.sort(
    (a, b) =>
      Number(a.suspect) - Number(b.suspect) ||
      Math.abs(b.divergence) - Math.abs(a.divergence),
  );
  return matches;
}
