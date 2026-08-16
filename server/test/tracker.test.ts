import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceTracker } from '../src/analysis/tracker.js';

describe('PriceTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-15T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ignores single-sample series', () => {
    const tracker = new PriceTracker();
    tracker.record('m1', 'Market 1', 'e1', 'Event 1', 0.5);
    expect(tracker.movers(60_000)).toEqual([]);
  });

  it('ignores series whose mid has not changed', () => {
    const tracker = new PriceTracker();
    tracker.record('m1', 'Market 1', 'e1', 'Event 1', 0.5);
    vi.advanceTimersByTime(10_000);
    tracker.record('m1', 'Market 1', 'e1', 'Event 1', 0.5);
    expect(tracker.movers(60_000)).toEqual([]);
  });

  it('returns movers ordered by largest |delta| within the window', () => {
    const tracker = new PriceTracker();
    tracker.record('up-small', 'Up Small', 'e', 'E', 0.5);
    tracker.record('down-big', 'Down Big', 'e', 'E', 0.4);
    vi.advanceTimersByTime(30_000);
    tracker.record('up-small', 'Up Small', 'e', 'E', 0.6); // +0.10
    tracker.record('down-big', 'Down Big', 'e', 'E', 0.15); // -0.25

    const movers = tracker.movers(60_000);
    expect(movers.map((m) => m.marketSlug)).toEqual(['down-big', 'up-small']);

    const [big, small] = movers;
    expect(big.delta).toBeCloseTo(-0.25, 12);
    expect(big.prevMid).toBeCloseTo(0.4, 12);
    expect(big.mid).toBeCloseTo(0.15, 12);
    expect(big.sinceMs).toBe(30_000);
    expect(big.title).toBe('Down Big');
    expect(big.eventSlug).toBe('e');

    expect(small.delta).toBeCloseTo(0.1, 12);
  });

  it('baselines against the oldest sample inside the window, not all history', () => {
    const tracker = new PriceTracker();
    tracker.record('m', 'M', 'e', 'E', 0.1); // t0 — outside the window below
    vi.advanceTimersByTime(50_000);
    tracker.record('m', 'M', 'e', 'E', 0.3); // t0+50s — inside window
    vi.advanceTimersByTime(20_000);
    tracker.record('m', 'M', 'e', 'E', 0.4); // now = t0+70s

    // 30s window: cutoff = t0+40s, so the 0.3 sample is the baseline, not 0.1.
    const movers = tracker.movers(30_000);
    expect(movers).toHaveLength(1);
    expect(movers[0].prevMid).toBeCloseTo(0.3, 12);
    expect(movers[0].delta).toBeCloseTo(0.1, 12);
    expect(movers[0].sinceMs).toBe(20_000);

    // A wide window reaches back to the very first sample.
    const wide = tracker.movers(600_000);
    expect(wide[0].prevMid).toBeCloseTo(0.1, 12);
    expect(wide[0].delta).toBeCloseTo(0.3, 12);
  });

  it('respects the limit parameter', () => {
    const tracker = new PriceTracker();
    for (let i = 0; i < 5; i++) {
      tracker.record(`m${i}`, `M${i}`, 'e', 'E', 0.5);
    }
    vi.advanceTimersByTime(10_000);
    for (let i = 0; i < 5; i++) {
      tracker.record(`m${i}`, `M${i}`, 'e', 'E', 0.5 + (i + 1) * 0.01);
    }

    const movers = tracker.movers(60_000, 2);
    expect(movers).toHaveLength(2);
    // Largest deltas first: m4 (+0.05) then m3 (+0.04).
    expect(movers.map((m) => m.marketSlug)).toEqual(['m4', 'm3']);
  });

  it('caps history via the ring buffer (240 samples) without breaking movers', () => {
    const tracker = new PriceTracker();
    // 300 samples, 1s apart, mid creeping upward.
    for (let i = 0; i < 300; i++) {
      tracker.record('m', 'M', 'e', 'E', 0.1 + i * 0.001);
      vi.advanceTimersByTime(1000);
    }
    // Window covering everything: baseline is the oldest *retained* sample,
    // i.e. sample #60 (300 - 240) at mid 0.1 + 60*0.001 = 0.16.
    const movers = tracker.movers(3_600_000);
    expect(movers).toHaveLength(1);
    expect(movers[0].prevMid).toBeCloseTo(0.16, 12);
    expect(movers[0].mid).toBeCloseTo(0.1 + 299 * 0.001, 12);
  });
});
