/**
 * Taker fees on both venues are quadratic in price — worst at $0.50, near
 * zero at the extremes — but rounded differently:
 *
 *   Polymarket US (schedule effective 2026-07-01):
 *     fee = 0.06 · C · p · (1 − p), banker's-rounded per fill.
 *     Markets carry their own `feeCoefficient` (0.06 observed everywhere).
 *
 *   Kalshi (general schedule):
 *     fee = ceil_to_cent( 0.07 · C · p · (1 − p) )  — rounded UP, which
 *     makes small Kalshi orders relatively more expensive.
 *
 * Both venues charge the same formula on either side of a market (p is the
 * executed trade price of whichever contract you traded), and neither
 * charges takers' counterparties (Polymarket pays makers a rebate).
 */
export const PM_TAKER_THETA = 0.06;
export const PM_MAKER_REBATE_THETA = 0.0125;
export const KALSHI_TAKER_THETA = 0.07;

export function pmTakerFee(price: number, theta = PM_TAKER_THETA): number {
  if (!(price > 0 && price < 1)) return 0;
  return theta * price * (1 - price);
}

export function pmMakerRebate(price: number, theta = PM_MAKER_REBATE_THETA): number {
  if (!(price > 0 && price < 1)) return 0;
  return theta * price * (1 - price);
}

/** Per-contract Kalshi taker fee, rounded up to the next cent (C = 1). */
export function kalshiTakerFee(price: number, theta = KALSHI_TAKER_THETA): number {
  if (!(price > 0 && price < 1)) return 0;
  return Math.ceil(theta * price * (1 - price) * 100) / 100;
}
