/** Token-bucket limiter. Polymarket US allows 20 req/s (per IP public, per key
 * authed); we default well under that. */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private ratePerSec: number, private burst = ratePerSec) {
    this.tokens = burst;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSec);
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = ((1 - this.tokens) / this.ratePerSec) * 1000;
      await new Promise((r) => setTimeout(r, Math.max(waitMs, 10)));
    }
  }
}

interface CacheEntry {
  expires: number;
  value: Promise<unknown>;
}

/** TTL cache that stores in-flight promises so concurrent callers share one fetch. */
export class TtlCache {
  private map = new Map<string, CacheEntry>();

  getOrFetch<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
    const value = fn().catch((err) => {
      // Don't cache failures.
      this.map.delete(key);
      throw err;
    });
    this.map.set(key, { expires: Date.now() + ttlMs, value });
    return value;
  }

  clear(): void {
    this.map.clear();
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
  }
}

export async function fetchJson<T>(
  url: string,
  opts: { headers?: Record<string, string>; method?: string; retries?: number } = {},
): Promise<T> {
  const { headers = {}, method = 'GET', retries = 2 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new HttpError(res.status, url, await res.text());
      }
      if (!res.ok) throw new HttpError(res.status, url, await res.text());
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      const retriable =
        err instanceof HttpError ? err.status === 429 || err.status >= 500 : true;
      if (!retriable || attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr;
}
