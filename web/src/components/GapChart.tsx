import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { fetchHistory } from '../api';
import type { GapSample, HistoryResponse } from '../api';
import { fmtCents, fmtSignedCents, fmtTimeShort } from '../format';

const WINDOWS = [
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 21_600_000 },
  { label: '24h', ms: 86_400_000 },
  { label: '48h', ms: 172_800_000 },
] as const;

const W = 680;
const H = 232;
const M = { top: 14, right: 18, bottom: 26, left: 46 };
const IW = W - M.left - M.right;
const IH = H - M.top - M.bottom;

const TICK_STEPS = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5];

function yTicks(min: number, max: number): number[] {
  const target = (max - min) / 4;
  const step = TICK_STEPS.find((s) => s >= target) ?? 0.5;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    out.push(Number(v.toFixed(4)));
  }
  return out;
}

interface Region {
  sign: 1 | -1;
  top: { t: number; v: number }[]; // pm line
  bot: { t: number; v: number }[]; // kalshi line
}

/**
 * Split the band between the two mid lines into same-sign regions so the
 * shading matches the gap bars: PM hue where PM is richer, Kalshi hue where
 * Kalshi is. Crossings are interpolated so regions meet exactly on the lines.
 */
function gapRegions(series: GapSample[]): Region[] {
  const regions: Region[] = [];
  let cur: Region | null = null;
  const push = (r: Region | null) => {
    if (r && r.top.length >= 2) regions.push(r);
  };
  const signOf = (g: number): 1 | -1 | 0 => (g > 0 ? 1 : g < 0 ? -1 : 0);
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const g = s.pmMid - s.kMid;
    const sg = signOf(g);
    if (!cur) {
      cur = { sign: sg === 0 ? 1 : sg, top: [], bot: [] };
    } else if (sg !== 0 && sg !== cur.sign) {
      // crossing between i-1 and i: interpolate the meeting point
      const prev = series[i - 1];
      const g0 = prev.pmMid - prev.kMid;
      const frac = g0 === g0 - g ? 0 : g0 / (g0 - g);
      const tc = prev.t + frac * (s.t - prev.t);
      const vc = prev.pmMid + frac * (s.pmMid - prev.pmMid);
      cur.top.push({ t: tc, v: vc });
      cur.bot.push({ t: tc, v: vc });
      push(cur);
      cur = { sign: sg, top: [{ t: tc, v: vc }], bot: [{ t: tc, v: vc }] };
    }
    cur.top.push({ t: s.t, v: s.pmMid });
    cur.bot.push({ t: s.t, v: s.kMid });
  }
  push(cur);
  return regions;
}

export function GapChart({ pairId }: { pairId: string }) {
  const [windowMs, setWindowMs] = useState<number>(21_600_000);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [hoverI, setHoverI] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchHistory(pairId, windowMs)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [pairId, windowMs, attempt]);

  const series = data?.series ?? [];

  const geom = useMemo(() => {
    if (series.length < 2) return null;
    const t0 = series[0].t;
    const t1 = series[series.length - 1].t;
    const tSpan = Math.max(t1 - t0, 60_000);
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const s of series) {
      vMin = Math.min(vMin, s.pmMid, s.kMid);
      vMax = Math.max(vMax, s.pmMid, s.kMid);
    }
    const pad = Math.max((vMax - vMin) * 0.15, 0.015);
    vMin = Math.max(0, vMin - pad);
    vMax = Math.min(1, vMax + pad);
    const x = (t: number) => M.left + ((t - t0) / tSpan) * IW;
    const y = (v: number) => M.top + (1 - (v - vMin) / (vMax - vMin)) * IH;
    const linePath = (pick: (s: GapSample) => number) =>
      series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(s.t).toFixed(2)} ${y(pick(s)).toFixed(2)}`).join(' ');
    const regionPath = (r: Region) => {
      const fwd = r.top.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.t).toFixed(2)} ${y(p.v).toFixed(2)}`);
      const back = [...r.bot].reverse().map((p) => `L ${x(p.t).toFixed(2)} ${y(p.v).toFixed(2)}`);
      return `${fwd.join(' ')} ${back.join(' ')} Z`;
    };
    const xTicks: number[] = [];
    for (let i = 0; i <= 3; i++) xTicks.push(t0 + (tSpan * i) / 3);
    return { t0, t1, x, y, vMin, vMax, linePath, regionPath, xTicks, yTickVals: yTicks(vMin, vMax) };
  }, [series]);

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!geom || !svgRef.current || series.length < 2) return;
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < series.length; i++) {
      const d = Math.abs(geom.x(series[i].t) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHoverI(best);
  };

  const windowButtons = (
    <div className="chart-windows" role="group" aria-label="History window">
      {WINDOWS.map((w) => (
        <button
          key={w.label}
          type="button"
          className="chip-btn chip-sm"
          aria-pressed={windowMs === w.ms}
          onClick={() => setWindowMs(w.ms)}
        >
          {w.label}
        </button>
      ))}
    </div>
  );

  let body: ReactNode;
  if (loading && !data) {
    body = <div className="chart-empty skeleton" style={{ height: H }} aria-label="Loading history" />;
  } else if (error) {
    body = (
      <div className="chart-empty">
        <span className="err-text">history fetch failed — {error}</span>
        <button type="button" className="chip-btn chip-sm" onClick={() => setAttempt((a) => a + 1)}>
          retry
        </button>
      </div>
    );
  } else if (!geom) {
    body = (
      <div className="chart-empty">
        collecting — sampling starts with the server
        {series.length === 1 ? ' (1 sample so far)' : ''}
      </div>
    );
  } else {
    const hover = hoverI !== null ? series[Math.min(hoverI, series.length - 1)] : null;
    const last = series[series.length - 1];
    const endPmY = geom.y(last.pmMid);
    const endKY = geom.y(last.kMid);
    // keep the two end labels from colliding when the lines converge
    let labPmY = endPmY;
    let labKY = endKY;
    if (Math.abs(labPmY - labKY) < 13) {
      const mid = (labPmY + labKY) / 2;
      const up = labPmY <= labKY ? 1 : -1;
      labPmY = mid - up * 7;
      labKY = mid + up * 7;
    }
    body = (
      <div className="chart-wrap">
        <svg
          ref={svgRef}
          className="gap-chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Polymarket and Kalshi mid prices over the selected window, ${series.length} samples`}
          onPointerMove={onMove}
          onPointerLeave={() => setHoverI(null)}
        >
          {/* gridlines */}
          {geom.yTickVals.map((v) => (
            <g key={`y${v}`}>
              <line
                x1={M.left}
                x2={W - M.right}
                y1={geom.y(v)}
                y2={geom.y(v)}
                stroke="var(--grid)"
                strokeWidth={1}
              />
              <text x={M.left - 6} y={geom.y(v) + 3} textAnchor="end" className="axis-text">
                {(v * 100).toFixed(v * 100 < 1 ? 1 : 0)}¢
              </text>
            </g>
          ))}
          {geom.xTicks.map((t, i) => (
            <text
              key={`x${i}`}
              x={geom.x(t)}
              y={H - 8}
              textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}
              className="axis-text"
            >
              {fmtTimeShort(t)}
            </text>
          ))}
          {/* gap shading between the lines, hue by which venue is richer */}
          {gapRegions(series).map((r, i) => (
            <path
              key={`r${i}`}
              d={geom.regionPath(r)}
              fill={r.sign === 1 ? 'var(--pm)' : 'var(--kx)'}
              opacity={0.13}
            />
          ))}
          {/* mid lines */}
          <path
            d={geom.linePath((s) => s.pmMid)}
            fill="none"
            stroke="var(--pm)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d={geom.linePath((s) => s.kMid)}
            fill="none"
            stroke="var(--kx)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* end markers with surface ring + selective end labels */}
          <circle cx={geom.x(last.t)} cy={endPmY} r={4.5} fill="var(--pm)" stroke="var(--surface)" strokeWidth={2} />
          <circle cx={geom.x(last.t)} cy={endKY} r={4.5} fill="var(--kx)" stroke="var(--surface)" strokeWidth={2} />
          <text x={W - M.right + 4} y={labPmY + 3} className="end-label" textAnchor="start">
            {fmtCentsBareLabel(last.pmMid)}
          </text>
          <text x={W - M.right + 4} y={labKY + 3} className="end-label" textAnchor="start">
            {fmtCentsBareLabel(last.kMid)}
          </text>
          {/* crosshair */}
          {hover && (
            <g>
              <line
                x1={geom.x(hover.t)}
                x2={geom.x(hover.t)}
                y1={M.top}
                y2={H - M.bottom}
                stroke="var(--muted)"
                strokeWidth={1}
              />
              <circle cx={geom.x(hover.t)} cy={geom.y(hover.pmMid)} r={4.5} fill="var(--pm)" stroke="var(--surface)" strokeWidth={2} />
              <circle cx={geom.x(hover.t)} cy={geom.y(hover.kMid)} r={4.5} fill="var(--kx)" stroke="var(--surface)" strokeWidth={2} />
            </g>
          )}
        </svg>
        {hover && (
          <div
            className="chart-tooltip"
            style={{
              left: `min(max(${((geom.x(hover.t) / W) * 100).toFixed(2)}%, 90px), calc(100% - 90px))`,
            }}
          >
            <div className="tt-time">{new Date(hover.t).toLocaleTimeString([], { hour12: false })}</div>
            <div className="tt-row">
              <span className="tt-key" style={{ background: 'var(--pm)' }} />
              <strong>{fmtCents(hover.pmMid)}</strong>
              <span className="tt-name">Polymarket</span>
            </div>
            <div className="tt-row">
              <span className="tt-key" style={{ background: 'var(--kx)' }} />
              <strong>{fmtCents(hover.kMid)}</strong>
              <span className="tt-name">Kalshi</span>
            </div>
            <div className="tt-row">
              <span className="tt-key tt-key-gap" />
              <strong>{fmtSignedCents(hover.pmMid - hover.kMid)}</strong>
              <span className="tt-name">gap</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="gap-history">
      <div className="chart-head">
        <span className="panel-title">Gap history</span>
        <span className="legend" aria-hidden="true">
          <span className="legend-item">
            <span className="legend-line" style={{ background: 'var(--pm)' }} /> Polymarket mid
          </span>
          <span className="legend-item">
            <span className="legend-line" style={{ background: 'var(--kx)' }} /> Kalshi mid
          </span>
          <span className="legend-item">
            <span className="legend-swatch" /> gap
          </span>
        </span>
        {windowButtons}
      </div>
      {body}
      {data?.stats && (
        <div className="chart-stats">
          {data.stats.samples} samples · max |gap| {fmtCents(data.stats.maxAbsGap)} · mean gap{' '}
          {fmtSignedCents(data.stats.meanGap)}
        </div>
      )}
    </div>
  );
}

const fmtCentsBareLabel = (v: number): string => `${(v * 100).toFixed(1)}¢`;
