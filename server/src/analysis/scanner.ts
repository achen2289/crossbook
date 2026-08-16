import { DEFAULT_TAKER_THETA, takerFeePerContract } from './fees.js';
import { quotePx } from '../pmus/types.js';
import type { PmEvent, PmMarket } from '../pmus/types.js';

export interface ScanLeg {
  marketSlug: string;
  title: string;
  bid?: number;
  ask?: number;
  mid?: number;
  theta: number;
  feeAtAsk: number;
  feeAtBid: number;
}

export interface ScanGroup {
  eventSlug: string;
  eventTitle: string;
  eventCategory?: string;
  groupTitle: string;
  legCount: number;
  complete: boolean;
  sumAsk: number;
  sumBid: number;
  sumMid: number;
  /** 1 when Σmid == 1 exactly; decays with distance. Partition sanity check. */
  partitionScore: number;
  longEdgeGross: number;
  longEdgeNet: number;
  shortEdgeGross: number;
  shortEdgeNet: number;
  kind: 'long' | 'short' | 'none';
  /** True when legs were refreshed from live book tops (vs embedded quotes). */
  refreshed?: boolean;
  executableLongSets?: number;
  executableShortSets?: number;
  legs: ScanLeg[];
}

// Wide net for browsing candidate groups.
const PARTITION_MID_MIN = 0.9;
const PARTITION_MID_MAX = 1.1;
// Flagging gates are asymmetric because the two arbs need different
// structure. LONG (buy every outcome, one must pay $1) requires the set to
// be EXHAUSTIVE: a Dem/Rep pair summing to 0.90 isn't mispriced — a third
// party can win, which is exactly why Σmid sags. A genuine long arb has
// Σmid ≤ Σask < 1, so the gate is a floor just below the actionable range.
// SHORT (sell every outcome, at most one may cost $1) doesn't need
// exhaustiveness — an unlisted outcome occurring means every sold leg
// expires worthless, which only helps — but it does need MUTUAL
// EXCLUSIVITY: nested ladders ("over 3.5" + "over 9.5", date thresholds)
// can pay multiple legs at once, and those sets price Σmid well above 1.
const LONG_MIN_MID = 0.95;
const SHORT_MAX_MID = 1.05;

function legFromMarket(m: PmMarket): ScanLeg {
  const ask = quotePx(m.bestAskQuote);
  const bid = quotePx(m.bestBidQuote);
  const theta = m.feeCoefficient ?? DEFAULT_TAKER_THETA;
  return {
    marketSlug: m.slug,
    title: m.titleShort || m.title || m.question || m.slug,
    bid,
    ask,
    mid: ask !== undefined && bid !== undefined ? (ask + bid) / 2 : ask ?? bid,
    theta,
    feeAtAsk: ask !== undefined ? takerFeePerContract(ask, theta) : 0,
    feeAtBid: bid !== undefined ? takerFeePerContract(bid, theta) : 0,
  };
}

function tradableMarkets(event: PmEvent): PmMarket[] {
  return (event.markets ?? []).filter(
    (m) => m.active !== false && m.closed !== true && m.hidden !== true,
  );
}

/**
 * Group an event's markets into candidate mutually-exclusive partitions.
 * Uses the event's own marketGroups when present (multi-outcome events);
 * otherwise treats all of the event's markets as one candidate group. Whether
 * the group truly is an exhaustive partition is then gated by Σmid ≈ 1 —
 * spread/total ladders and other non-partitions fail that check naturally.
 */
export function groupsForEvent(event: PmEvent): { title: string; markets: PmMarket[] }[] {
  const markets = tradableMarkets(event);
  if (markets.length < 2) return [];
  const groups = event.marketGroups ?? [];
  if (groups.length > 0) {
    const byId = new Map(markets.map((m) => [String(m.id), m]));
    const out: { title: string; markets: PmMarket[] }[] = [];
    // Parent and child marketGroups entries can reference the same market
    // set; dedupe by the set signature so a group is scanned once.
    const seen = new Set<string>();
    for (const g of groups) {
      const ms = (g.marketIds ?? [])
        .map((id) => byId.get(String(id)))
        .filter((m): m is PmMarket => Boolean(m));
      if (ms.length < 2) continue;
      const sig = ms.map((m) => m.slug).sort().join('|');
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ title: g.title ?? event.title, markets: ms });
    }
    if (out.length > 0) return out;
  }
  return [{ title: event.title, markets }];
}

/** (Re)derive sums, edges, and kind from the group's current legs. */
export function computeGroupMetrics(legs: ScanLeg[]): Pick<
  ScanGroup,
  | 'complete'
  | 'sumAsk'
  | 'sumBid'
  | 'sumMid'
  | 'partitionScore'
  | 'longEdgeGross'
  | 'longEdgeNet'
  | 'shortEdgeGross'
  | 'shortEdgeNet'
  | 'kind'
> {
  const allAsks = legs.every((l) => l.ask !== undefined);
  const allBids = legs.every((l) => l.bid !== undefined);
  const complete = allAsks && allBids;
  const sumAsk = legs.reduce((s, l) => s + (l.ask ?? 0), 0);
  const sumBid = legs.reduce((s, l) => s + (l.bid ?? 0), 0);
  const sumMid = legs.reduce((s, l) => s + (l.mid ?? 0), 0);
  // Buying one contract of every outcome costs Σask + fees and pays $1.
  // Only meaningful when every leg has an ask (one-sided books otherwise
  // fake a "free" leg); sentinel -1 keeps unusable sides out of rankings.
  const longEdgeGross = allAsks ? 1 - sumAsk : -1;
  const longEdgeNet = allAsks
    ? longEdgeGross - legs.reduce((s, l) => s + l.feeAtAsk, 0)
    : -1;
  // Selling one contract of every outcome receives Σbid and owes $1.
  const shortEdgeGross = allBids ? sumBid - 1 : -1;
  const shortEdgeNet = allBids
    ? shortEdgeGross - legs.reduce((s, l) => s + l.feeAtBid, 0)
    : -1;
  const partitionScore = Math.max(0, 1 - Math.abs(1 - sumMid));
  const kind: ScanGroup['kind'] =
    allAsks && longEdgeNet > 0 && sumMid >= LONG_MIN_MID
      ? 'long'
      : allBids && shortEdgeNet > 0 && sumMid <= SHORT_MAX_MID
        ? 'short'
        : 'none';
  return {
    complete,
    sumAsk,
    sumBid,
    sumMid,
    partitionScore,
    longEdgeGross,
    longEdgeNet,
    shortEdgeGross,
    shortEdgeNet,
    kind,
  };
}

export function scanEvent(event: PmEvent): ScanGroup[] {
  const results: ScanGroup[] = [];
  for (const group of groupsForEvent(event)) {
    const legs = group.markets.map(legFromMarket);
    results.push({
      eventSlug: event.slug,
      eventTitle: event.title,
      eventCategory: event.category,
      groupTitle: group.title,
      legCount: legs.length,
      ...computeGroupMetrics(legs),
      legs,
    });
  }
  return results;
}

export interface ScanOptions {
  /** Include groups with no positive net edge (for browsing consistency). */
  includeAll?: boolean;
  minPartitionScore?: number;
}

export function scanUniverse(events: PmEvent[], opts: ScanOptions = {}): ScanGroup[] {
  const { includeAll = false, minPartitionScore = 0.9 } = opts;
  const out: ScanGroup[] = [];
  for (const ev of events) {
    for (const g of scanEvent(ev)) {
      // Need at least one fully-quoted side to say anything useful.
      if ((!g.complete && g.kind === 'none') || g.partitionScore < minPartitionScore) continue;
      if (!includeAll && g.kind === 'none') continue;
      out.push(g);
    }
  }
  out.sort(
    (a, b) =>
      Math.max(b.longEdgeNet, b.shortEdgeNet) - Math.max(a.longEdgeNet, a.shortEdgeNet),
  );
  return out;
}
