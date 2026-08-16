/**
 * Polymarket US fee model (fee schedule effective 2026-07-01):
 *   fee = theta * contracts * p * (1 - p)
 * Taker theta = 0.06, maker rebate theta = -0.0125. Fees peak at p = $0.50
 * and vanish toward $0/$1. Markets carry their own `feeCoefficient` (taker
 * theta); we default to 0.06 when absent.
 */
export const DEFAULT_TAKER_THETA = 0.06;
export const MAKER_REBATE_THETA = 0.0125;

export function takerFeePerContract(price: number, theta = DEFAULT_TAKER_THETA): number {
  if (!(price > 0 && price < 1)) return 0;
  return theta * price * (1 - price);
}

export function makerRebatePerContract(price: number, theta = MAKER_REBATE_THETA): number {
  if (!(price > 0 && price < 1)) return 0;
  return theta * price * (1 - price);
}
