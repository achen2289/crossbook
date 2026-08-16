import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAKER_THETA,
  MAKER_REBATE_THETA,
  makerRebatePerContract,
  takerFeePerContract,
} from '../src/analysis/fees.js';

describe('takerFeePerContract', () => {
  it('peaks at p = 0.5: 0.06 * 0.5 * 0.5 = 0.015', () => {
    expect(takerFeePerContract(0.5)).toBe(0.015);
  });

  it('is 0.0054 at p = 0.1', () => {
    expect(takerFeePerContract(0.1)).toBe(0.0054);
  });

  it('is symmetric around 0.5: fee(0.1) == fee(0.9)', () => {
    expect(takerFeePerContract(0.9)).toBeCloseTo(0.0054, 15);
    expect(takerFeePerContract(0.9)).toBeCloseTo(takerFeePerContract(0.1), 15);
    expect(takerFeePerContract(0.25)).toBeCloseTo(takerFeePerContract(0.75), 15);
  });

  it('vanishes at the boundaries p = 0 and p = 1', () => {
    expect(takerFeePerContract(0)).toBe(0);
    expect(takerFeePerContract(1)).toBe(0);
  });

  it('is 0 outside the (0, 1) range', () => {
    expect(takerFeePerContract(-0.2)).toBe(0);
    expect(takerFeePerContract(1.5)).toBe(0);
  });

  it('honors a custom theta (per-market feeCoefficient)', () => {
    expect(takerFeePerContract(0.5, 0.02)).toBe(0.005);
    expect(takerFeePerContract(0.25, 0.08)).toBeCloseTo(0.08 * 0.25 * 0.75, 15);
    // theta = 0 means no fee anywhere.
    expect(takerFeePerContract(0.5, 0)).toBe(0);
  });

  it('exposes the documented default theta', () => {
    expect(DEFAULT_TAKER_THETA).toBe(0.06);
  });
});

describe('makerRebatePerContract', () => {
  it('uses the 0.0125 rebate theta by default', () => {
    expect(MAKER_REBATE_THETA).toBe(0.0125);
    expect(makerRebatePerContract(0.5)).toBe(0.0125 * 0.5 * 0.5); // 0.003125
    expect(makerRebatePerContract(0.5)).toBe(0.003125);
    expect(makerRebatePerContract(0.2)).toBeCloseTo(0.0125 * 0.2 * 0.8, 15);
  });

  it('vanishes at the boundaries and accepts a custom theta', () => {
    expect(makerRebatePerContract(0)).toBe(0);
    expect(makerRebatePerContract(1)).toBe(0);
    expect(makerRebatePerContract(0.5, 0.04)).toBe(0.01);
  });
});
