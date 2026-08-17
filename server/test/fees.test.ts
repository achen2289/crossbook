import { describe, expect, it } from 'vitest';
import {
  KALSHI_TAKER_THETA,
  PM_MAKER_REBATE_THETA,
  PM_TAKER_THETA,
  kalshiTakerFee,
  pmMakerRebate,
  pmTakerFee,
} from '../src/analysis/fees.js';

describe('theta constants', () => {
  it('exposes the documented schedule coefficients', () => {
    expect(PM_TAKER_THETA).toBe(0.06);
    expect(PM_MAKER_REBATE_THETA).toBe(0.0125);
    expect(KALSHI_TAKER_THETA).toBe(0.07);
  });
});

describe('pmTakerFee', () => {
  it('peaks at p = 0.5: 0.06 * 0.5 * 0.5 = 0.015 exactly (no rounding)', () => {
    expect(pmTakerFee(0.5)).toBe(0.015);
  });

  it('is 0.0054 at p = 0.1', () => {
    expect(pmTakerFee(0.1)).toBe(0.0054);
  });

  it('is symmetric around 0.5: fee(p) == fee(1 - p)', () => {
    expect(pmTakerFee(0.9)).toBeCloseTo(0.0054, 15);
    expect(pmTakerFee(0.9)).toBeCloseTo(pmTakerFee(0.1), 15);
    expect(pmTakerFee(0.25)).toBeCloseTo(pmTakerFee(0.75), 15);
  });

  it('vanishes at the boundaries and outside (0, 1)', () => {
    expect(pmTakerFee(0)).toBe(0);
    expect(pmTakerFee(1)).toBe(0);
    expect(pmTakerFee(-0.2)).toBe(0);
    expect(pmTakerFee(1.5)).toBe(0);
  });

  it('honors a custom theta (per-market feeCoefficient)', () => {
    expect(pmTakerFee(0.5, 0.02)).toBe(0.005);
    expect(pmTakerFee(0.25, 0.08)).toBeCloseTo(0.08 * 0.25 * 0.75, 15);
    // theta = 0 means no fee anywhere.
    expect(pmTakerFee(0.5, 0)).toBe(0);
  });
});

describe('pmMakerRebate', () => {
  it('uses the 0.0125 rebate theta by default', () => {
    expect(pmMakerRebate(0.5)).toBe(0.003125);
    expect(pmMakerRebate(0.2)).toBeCloseTo(0.0125 * 0.2 * 0.8, 15);
  });

  it('vanishes at the boundaries and accepts a custom theta', () => {
    expect(pmMakerRebate(0)).toBe(0);
    expect(pmMakerRebate(1)).toBe(0);
    expect(pmMakerRebate(0.5, 0.04)).toBe(0.01);
  });
});

describe('kalshiTakerFee', () => {
  it('rounds UP to the next cent: at p = 0.5, ceil(1.75¢) = 2¢', () => {
    // Unrounded: 0.07 * 0.5 * 0.5 = 0.0175. Kalshi charges 0.02.
    expect(kalshiTakerFee(0.5)).toBe(0.02);
    expect(kalshiTakerFee(0.5)).toBeGreaterThan(0.07 * 0.5 * 0.5);
  });

  it('rounds up at p = 0.1: ceil(0.63¢) = 1¢', () => {
    expect(kalshiTakerFee(0.1)).toBe(0.01);
  });

  it('never charges less than a full cent inside (0, 1), even at extreme prices', () => {
    // Unrounded fee at p = 0.99 is 0.0693¢ — still billed as 1¢.
    expect(kalshiTakerFee(0.99)).toBe(0.01);
    expect(kalshiTakerFee(0.01)).toBe(0.01);
  });

  it('steps between whole cents as the unrounded fee crosses cent boundaries', () => {
    expect(kalshiTakerFee(0.15)).toBe(0.01); // 0.8925¢ -> 1¢
    expect(kalshiTakerFee(0.3)).toBe(0.02); // 1.47¢  -> 2¢
  });

  it('is strictly more expensive than the PM taker fee at p = 0.5', () => {
    // Same quadratic shape, but theta 0.07 vs 0.06 AND ceil rounding:
    // PM charges 1.5¢ where Kalshi charges 2¢.
    expect(pmTakerFee(0.5)).toBe(0.015);
    expect(kalshiTakerFee(0.5)).toBe(0.02);
    expect(kalshiTakerFee(0.5) - pmTakerFee(0.5)).toBeCloseTo(0.005, 15);
  });

  it('vanishes at the boundaries and outside (0, 1)', () => {
    expect(kalshiTakerFee(0)).toBe(0);
    expect(kalshiTakerFee(1)).toBe(0);
    expect(kalshiTakerFee(-0.5)).toBe(0);
    expect(kalshiTakerFee(1.2)).toBe(0);
  });

  it('applies ceil rounding to a custom theta too', () => {
    // 0.14 * 0.5 * 0.5 = 0.035 -> 3.5¢ -> 4¢.
    expect(kalshiTakerFee(0.5, 0.14)).toBe(0.04);
  });
});
