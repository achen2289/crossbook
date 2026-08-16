/** In-session price history. The retail API exposes no historical prices or
 * price-change fields, so Polyscope samples mid prices while running and
 * computes movers from its own ring buffer. */

interface Sample {
  t: number;
  mid: number;
}

interface Series {
  title: string;
  eventSlug: string;
  eventTitle: string;
  samples: Sample[];
}

export interface Mover {
  marketSlug: string;
  title: string;
  eventSlug: string;
  eventTitle: string;
  mid: number;
  prevMid: number;
  delta: number;
  sinceMs: number;
}

const MAX_SAMPLES = 240;

export class PriceTracker {
  private series = new Map<string, Series>();
  readonly startedAt = Date.now();

  record(marketSlug: string, title: string, eventSlug: string, eventTitle: string, mid: number): void {
    let s = this.series.get(marketSlug);
    if (!s) {
      s = { title, eventSlug, eventTitle, samples: [] };
      this.series.set(marketSlug, s);
    }
    s.samples.push({ t: Date.now(), mid });
    if (s.samples.length > MAX_SAMPLES) s.samples.shift();
  }

  movers(windowMs: number, limit = 20): Mover[] {
    const cutoff = Date.now() - windowMs;
    const out: Mover[] = [];
    for (const [slug, s] of this.series) {
      if (s.samples.length < 2) continue;
      const latest = s.samples[s.samples.length - 1];
      // Oldest sample inside the window (or the very oldest we have).
      const base = s.samples.find((x) => x.t >= cutoff) ?? s.samples[0];
      if (base === latest) continue;
      const delta = latest.mid - base.mid;
      if (delta === 0) continue;
      out.push({
        marketSlug: slug,
        title: s.title,
        eventSlug: s.eventSlug,
        eventTitle: s.eventTitle,
        mid: latest.mid,
        prevMid: base.mid,
        delta,
        sinceMs: latest.t - base.t,
      });
    }
    out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return out.slice(0, limit);
  }
}
