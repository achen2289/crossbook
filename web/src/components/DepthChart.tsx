/**
 * Hand-rolled SVG order-book depth chart: cumulative step-areas, bids from
 * the best bid leftward (green), asks from the best ask rightward (red),
 * a mid marker, and a hover crosshair with a price/depth readout.
 * Values are also available in the adjacent top-of-book table and BBO
 * stats, so the tooltip enhances rather than gates.
 */
import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { BookLevel } from '../api';
import { fmtCents, fmtQty } from '../api';

interface Level {
  px: number;
  cum: number;
}

function cumulative(levels: BookLevel[] | undefined, dir: 'desc' | 'asc'): Level[] {
  const parsed = (levels ?? [])
    .map((l) => ({ px: parseFloat(l.px.value), qty: parseFloat(l.qty) }))
    .filter((l) => Number.isFinite(l.px) && Number.isFinite(l.qty) && l.qty > 0)
    .sort((a, b) => (dir === 'desc' ? b.px - a.px : a.px - b.px));
  let cum = 0;
  return parsed.map((l) => ({ px: l.px, cum: (cum += l.qty) }));
}

const W = 640;
const H = 220;
const M = { top: 28, right: 10, bottom: 22, left: 10 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

export function DepthChart({
  bids,
  asks,
  mid,
}: {
  bids?: BookLevel[];
  asks?: BookLevel[];
  mid?: number;
}) {
  const bidC = useMemo(() => cumulative(bids, 'desc'), [bids]);
  const askC = useMemo(() => cumulative(asks, 'asc'), [asks]);
  const [hoverPx, setHoverPx] = useState<number | null>(null);

  if (bidC.length === 0 && askC.length === 0) {
    return <div className="empty-note">Order book is empty.</div>;
  }

  const candidates: number[] = [];
  if (bidC.length > 0) candidates.push(bidC[0].px, bidC[bidC.length - 1].px);
  if (askC.length > 0) candidates.push(askC[0].px, askC[askC.length - 1].px);
  if (mid !== undefined) candidates.push(mid);
  const rawLo = Math.min(...candidates);
  const rawHi = Math.max(...candidates);
  const span = Math.max(rawHi - rawLo, 0.02);
  const lo = Math.max(0, rawLo - span * 0.05);
  const hi = Math.min(1, rawHi + span * 0.05);

  const maxDepth = Math.max(
    bidC.length > 0 ? bidC[bidC.length - 1].cum : 0,
    askC.length > 0 ? askC[askC.length - 1].cum : 0,
  );
  const yMax = maxDepth > 0 ? maxDepth * 1.08 : 1;

  const x = (px: number) => M.left + ((px - lo) / (hi - lo)) * PLOT_W;
  const y = (c: number) => M.top + PLOT_H - (c / yMax) * PLOT_H;
  const y0 = M.top + PLOT_H;

  /** Step polyline from the side's best price out to the chart edge. */
  const sideLine = (levels: Level[], edgePx: number): string => {
    if (levels.length === 0) return '';
    const parts: string[] = [
      `M ${x(levels[0].px).toFixed(2)} ${y0.toFixed(2)}`,
      `L ${x(levels[0].px).toFixed(2)} ${y(levels[0].cum).toFixed(2)}`,
    ];
    for (let i = 1; i < levels.length; i++) {
      parts.push(`H ${x(levels[i].px).toFixed(2)}`, `V ${y(levels[i].cum).toFixed(2)}`);
    }
    parts.push(`H ${x(edgePx).toFixed(2)}`);
    return parts.join(' ');
  };

  const bidLine = sideLine(bidC, lo);
  const askLine = sideLine(askC, hi);

  const depthAt = (px: number): { side: 'bid' | 'ask' | 'spread'; depth: number } => {
    if (bidC.length > 0 && px <= bidC[0].px) {
      let d = 0;
      for (const l of bidC) {
        if (l.px >= px) d = l.cum;
        else break;
      }
      return { side: 'bid', depth: d };
    }
    if (askC.length > 0 && px >= askC[0].px) {
      let d = 0;
      for (const l of askC) {
        if (l.px <= px) d = l.cum;
        else break;
      }
      return { side: 'ask', depth: d };
    }
    return { side: 'spread', depth: 0 };
  };

  const onMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const xv = ((e.clientX - rect.left) / rect.width) * W;
    if (xv < M.left || xv > W - M.right) {
      setHoverPx(null);
      return;
    }
    setHoverPx(lo + ((xv - M.left) / PLOT_W) * (hi - lo));
  };

  const hover = hoverPx !== null ? depthAt(hoverPx) : null;
  const showMid = mid !== undefined && mid >= lo && mid <= hi;

  return (
    <figure className="depth-chart">
      <figcaption className="chart-legend">
        <span className="legend-key">
          <span className="swatch swatch-bid" />
          Bids (cumulative)
        </span>
        <span className="legend-key">
          <span className="swatch swatch-ask" />
          Asks (cumulative)
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="depth-svg"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverPx(null)}
        role="img"
        aria-label="Order book depth: cumulative bid and ask size by price"
      >
        <line x1={M.left} x2={W - M.right} y1={y0} y2={y0} className="axis-line" />
        {bidLine && (
          <>
            <path d={`${bidLine} V ${y0.toFixed(2)} Z`} className="depth-area-bid" />
            <path d={bidLine} className="depth-line-bid" />
          </>
        )}
        {askLine && (
          <>
            <path d={`${askLine} V ${y0.toFixed(2)} Z`} className="depth-area-ask" />
            <path d={askLine} className="depth-line-ask" />
          </>
        )}
        {showMid && mid !== undefined && (
          <g>
            <line x1={x(mid)} x2={x(mid)} y1={M.top} y2={y0} className="mid-line" />
            {/* Clamp away from the right edge so it can't collide with the
                max-depth label anchored there. */}
            <text
              x={Math.max(M.left + 40, Math.min(x(mid), W - M.right - 110))}
              y={M.top - 8}
              textAnchor="middle"
              className="chart-label"
            >
              mid {fmtCents(mid)}
            </text>
          </g>
        )}
        {hoverPx !== null && hover && (
          <g>
            <line x1={x(hoverPx)} x2={x(hoverPx)} y1={M.top} y2={y0} className="crosshair" />
            <text x={W - M.right} y={M.top - 8} textAnchor="end" className="chart-readout">
              {fmtCents(hoverPx)} ·{' '}
              {hover.side === 'spread'
                ? 'inside spread'
                : `${fmtQty(hover.depth)} ${hover.side} depth`}
            </text>
          </g>
        )}
        <text x={M.left} y={H - 6} textAnchor="start" className="chart-label">
          {fmtCents(lo)}
        </text>
        <text x={W - M.right} y={H - 6} textAnchor="end" className="chart-label">
          {fmtCents(hi)}
        </text>
        {!hover && (
          <text x={W - M.right} y={M.top - 8} textAnchor="end" className="chart-label">
            max depth {fmtQty(maxDepth)}
          </text>
        )}
      </svg>
    </figure>
  );
}
