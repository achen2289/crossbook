import fs from 'node:fs';
import path from 'node:path';

/**
 * Gap history: one sample per pair per cycle, kept in memory and appended to
 * a JSONL file so restarts don't wipe the charts. Neither venue's public API
 * serves historical prices, so everything here is self-observed.
 */

export interface GapSample {
  t: number;
  pmMid: number;
  kMid: number;
}

export interface GapStats {
  samples: number;
  firstT: number;
  lastT: number;
  maxAbsGap: number;
  meanGap: number;
}

const MAX_SAMPLES_PER_PAIR = 2880; // 48h at one per minute
const MAX_AGE_MS = 48 * 3600 * 1000;

export class GapHistory {
  private series = new Map<string, GapSample[]>();
  private stream?: fs.WriteStream;

  constructor(private file?: string) {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.load(file);
    // Compact on boot: rewrite only what survived the 48h window so the
    // file can't grow without bound across long runs.
    if (fs.existsSync(file)) {
      const lines: string[] = [];
      for (const [id, samples] of this.series) {
        for (const s of samples) {
          lines.push(JSON.stringify({ id, t: s.t, p: s.pmMid, k: s.kMid }));
        }
      }
      fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
    }
    this.stream = fs.createWriteStream(file, { flags: 'a' });
  }

  private load(file: string): void {
    if (!fs.existsSync(file)) return;
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const { id, t, p, k } = JSON.parse(line) as { id: string; t: number; p: number; k: number };
        if (t < cutoff) continue;
        this.push(id, { t, pmMid: p, kMid: k });
      } catch {
        // Skip torn/corrupt lines (e.g. a write interrupted by a crash).
      }
    }
  }

  private push(id: string, s: GapSample): void {
    let arr = this.series.get(id);
    if (!arr) {
      arr = [];
      this.series.set(id, arr);
    }
    arr.push(s);
    if (arr.length > MAX_SAMPLES_PER_PAIR) arr.shift();
  }

  record(id: string, pmMid: number, kMid: number): void {
    const t = Date.now();
    this.push(id, { t, pmMid, kMid });
    this.stream?.write(`${JSON.stringify({ id, t, p: pmMid, k: kMid })}\n`);
  }

  serie(id: string, sinceMs?: number): GapSample[] {
    const arr = this.series.get(id) ?? [];
    if (!sinceMs) return arr;
    const cutoff = Date.now() - sinceMs;
    return arr.filter((s) => s.t >= cutoff);
  }

  stats(id: string): GapStats | undefined {
    const arr = this.series.get(id);
    if (!arr || arr.length === 0) return undefined;
    let maxAbs = 0;
    let sum = 0;
    for (const s of arr) {
      const gap = s.pmMid - s.kMid;
      sum += gap;
      if (Math.abs(gap) > maxAbs) maxAbs = Math.abs(gap);
    }
    return {
      samples: arr.length,
      firstT: arr[0].t,
      lastT: arr[arr.length - 1].t,
      maxAbsGap: maxAbs,
      meanGap: sum / arr.length,
    };
  }

  get trackedPairs(): number {
    return this.series.size;
  }
}
