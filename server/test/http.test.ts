import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter, TtlCache } from '../src/util/http.js';

describe('TtlCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dedupes concurrent callers onto one in-flight fetch', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    };

    const [a, b, c] = await Promise.all([
      cache.getOrFetch('k', 1000, fn),
      cache.getOrFetch('k', 1000, fn),
      cache.getOrFetch('k', 1000, fn),
    ]);

    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(c).toBe(42);
    expect(calls).toBe(1);
  });

  it('serves the cached value within ttl and refetches after expiry', async () => {
    vi.useFakeTimers();
    const cache = new TtlCache();
    let calls = 0;
    const fn = async () => ++calls;

    await expect(cache.getOrFetch('k', 1000, fn)).resolves.toBe(1);
    expect(calls).toBe(1);

    vi.advanceTimersByTime(999); // still inside ttl
    await expect(cache.getOrFetch('k', 1000, fn)).resolves.toBe(1);
    expect(calls).toBe(1);

    vi.advanceTimersByTime(2); // past ttl
    await expect(cache.getOrFetch('k', 1000, fn)).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  it('keeps distinct keys separate', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const fn = async () => ++calls;
    await cache.getOrFetch('a', 1000, fn);
    await cache.getOrFetch('b', 1000, fn);
    expect(calls).toBe(2);
  });

  it('does not cache rejections', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error('boom');
    };

    await expect(cache.getOrFetch('k', 60_000, failing)).rejects.toThrow('boom');
    expect(calls).toBe(1);

    // Same key immediately afterwards must hit the source again...
    const ok = async () => {
      calls++;
      return 'recovered';
    };
    await expect(cache.getOrFetch('k', 60_000, ok)).resolves.toBe('recovered');
    expect(calls).toBe(2);

    // ...and the successful value is then cached normally.
    await expect(cache.getOrFetch('k', 60_000, ok)).resolves.toBe('recovered');
    expect(calls).toBe(2);
  });

  it('clear() empties the cache', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const fn = async () => ++calls;
    await cache.getOrFetch('k', 60_000, fn);
    cache.clear();
    await cache.getOrFetch('k', 60_000, fn);
    expect(calls).toBe(2);
  });
});

describe('RateLimiter', () => {
  // Real timers: the limiter mixes Date.now() with setTimeout, so fake timers
  // would deadlock the awaited sleep. Small rate keeps the test well under 2s.
  it('allows the initial burst immediately, then delays to the refill rate', async () => {
    const limiter = new RateLimiter(20, 2); // 20 tokens/s, burst of 2 → ~50ms per extra token

    const t0 = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    const burstElapsed = Date.now() - t0;
    expect(burstElapsed).toBeLessThan(40); // burst is not throttled

    await limiter.acquire(); // must wait ~50ms for a token to refill
    const thirdElapsed = Date.now() - t0;
    expect(thirdElapsed).toBeGreaterThanOrEqual(35);
    expect(thirdElapsed).toBeLessThan(1000);
  });

  it('defaults burst to the per-second rate', async () => {
    const limiter = new RateLimiter(50); // burst defaults to 50
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) await limiter.acquire();
    expect(Date.now() - t0).toBeLessThan(100); // 10 < burst → no throttling
  });
});
