import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GapHistory } from '../src/analysis/history.js';

const TMP = fileURLToPath(new URL('./.tmp/', import.meta.url));
const FILE = path.join(TMP, 'gaps.jsonl');

const HOUR = 3600 * 1000;

const line = (id: string, t: number, p: number, k: number) => JSON.stringify({ id, t, p, k });

/**
 * File-backed GapHistory opens its append stream lazily on the event loop.
 * When a test tears down the scratch dir before that open lands, the stream
 * emits ENOENT with no listener attached, which vitest reports as an
 * unhandled error. None of these instances write after teardown, so a no-op
 * listener keeps the run deterministic without touching src behavior.
 */
function hist(file: string): GapHistory {
  const h = new GapHistory(file);
  (h as unknown as { stream?: NodeJS.EventEmitter }).stream?.on('error', () => {});
  return h;
}

const fileLines = () => fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('GapHistory in memory', () => {
  it('records samples and serves serie/stats/trackedPairs', () => {
    vi.useFakeTimers();
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);

    const h = new GapHistory(); // no file: purely in-memory
    h.record('a', 0.6, 0.5);
    vi.advanceTimersByTime(60_000);
    h.record('a', 0.4, 0.55);
    h.record('b', 0.5, 0.5);

    expect(h.trackedPairs).toBe(2);
    expect(h.serie('a')).toEqual([
      { t: t0, pmMid: 0.6, kMid: 0.5 },
      { t: t0 + 60_000, pmMid: 0.4, kMid: 0.55 },
    ]);
    expect(h.serie('missing')).toEqual([]);

    const s = h.stats('a')!;
    expect(s.samples).toBe(2);
    expect(s.firstT).toBe(t0);
    expect(s.lastT).toBe(t0 + 60_000);
    // gaps are +0.10 and -0.15
    expect(s.maxAbsGap).toBeCloseTo(0.15, 12);
    expect(s.meanGap).toBeCloseTo((0.1 - 0.15) / 2, 12);

    expect(h.stats('missing')).toBeUndefined();
  });

  it('serie(sinceMs) filters to the trailing window, inclusive of the cutoff', () => {
    vi.useFakeTimers();
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);

    const h = new GapHistory();
    h.record('a', 0.5, 0.4);
    vi.advanceTimersByTime(10 * 60_000);
    h.record('a', 0.52, 0.4);

    expect(h.serie('a')).toHaveLength(2);
    const recent = h.serie('a', 5 * 60_000);
    expect(recent).toHaveLength(1);
    expect(recent[0].t).toBe(t0 + 10 * 60_000);
    // Cutoff is inclusive: a window reaching exactly back to t0 keeps both.
    expect(h.serie('a', 10 * 60_000)).toHaveLength(2);
  });

  it('caps each pair at 2880 samples, evicting the oldest', () => {
    vi.useFakeTimers();
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);

    const h = new GapHistory();
    for (let i = 0; i < 2881; i++) {
      h.record('p', 0.5, 0.4);
      vi.advanceTimersByTime(1000);
    }
    const arr = h.serie('p');
    expect(arr).toHaveLength(2880);
    expect(arr[0].t).toBe(t0 + 1000); // the very first sample was shifted out
    expect(arr[arr.length - 1].t).toBe(t0 + 2880 * 1000);
    expect(h.stats('p')!.samples).toBe(2880);
  });
});

describe('GapHistory persistence', () => {
  it('round-trips samples through the JSONL file into a fresh instance', async () => {
    const h1 = hist(FILE);
    h1.record('pair-1', 0.61, 0.55);
    h1.record('pair-1', 0.62, 0.56);
    h1.record('pair-2', 0.1, 0.12);

    // The append stream flushes asynchronously; wait for all three lines.
    await vi.waitFor(() => {
      expect(fileLines()).toHaveLength(3);
    });

    const parsed = fileLines().map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(Object.keys(parsed[0]).sort()).toEqual(['id', 'k', 'p', 't']);
    expect(parsed[0]).toMatchObject({ id: 'pair-1', p: 0.61, k: 0.55 });

    const h2 = hist(FILE);
    expect(h2.trackedPairs).toBe(2);
    expect(h2.serie('pair-1')).toEqual(h1.serie('pair-1')); // timestamps preserved
    expect(h2.serie('pair-2')).toEqual(h1.serie('pair-2'));

    // Boot compaction rewrote the same three surviving samples.
    expect(fileLines()).toHaveLength(3);
  });

  it('creates the parent directory and the file on first record', async () => {
    const deep = path.join(TMP, 'nested', 'dir', 'gaps.jsonl');
    const h = hist(deep);
    expect(fs.existsSync(path.dirname(deep))).toBe(true);
    h.record('a', 0.5, 0.5);
    await vi.waitFor(() => {
      expect(fs.readFileSync(deep, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    });
  });

  it('skips samples older than 48h and corrupt lines on load', () => {
    const now = Date.now();
    fs.writeFileSync(
      FILE,
      [
        line('a', now - 49 * HOUR, 0.9, 0.1), // stale: outside the window
        line('a', now - 60_000, 0.5, 0.45), // fresh
        '{"id":"a","t":17', // torn write
        'not json at all', // garbage
        line('b', now - 1000, 0.3, 0.35), // fresh
      ].join('\n') + '\n',
    );

    const h = hist(FILE);
    expect(h.trackedPairs).toBe(2);
    expect(h.serie('a')).toEqual([{ t: now - 60_000, pmMid: 0.5, kMid: 0.45 }]);
    expect(h.serie('b')).toEqual([{ t: now - 1000, pmMid: 0.3, kMid: 0.35 }]);
  });

  it('compacts the file on boot down to the surviving samples', () => {
    const now = Date.now();
    fs.writeFileSync(
      FILE,
      [
        line('a', now - 49 * HOUR, 0.9, 0.1),
        line('a', now - 60_000, 0.5, 0.45),
        '{"id":"a","t":17',
        'not json at all',
        line('b', now - 1000, 0.3, 0.35),
      ].join('\n') + '\n',
    );
    const sizeBefore = fs.statSync(FILE).size;

    hist(FILE);

    const lines = fileLines();
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => (JSON.parse(l) as { id: string }).id).sort()).toEqual(['a', 'b']);
    for (const l of lines) {
      expect(Object.keys(JSON.parse(l) as object).sort()).toEqual(['id', 'k', 'p', 't']);
    }
    expect(fs.statSync(FILE).size).toBeLessThan(sizeBefore);
  });

  it('compacts to an empty file when every sample has aged out', () => {
    fs.writeFileSync(FILE, `${line('x', Date.now() - 50 * HOUR, 0.5, 0.5)}\n`);
    const h = hist(FILE);
    expect(h.trackedPairs).toBe(0);
    expect(h.serie('x')).toEqual([]);
    expect(fs.readFileSync(FILE, 'utf8')).toBe('');
  });
});
