import { fmtSignedCents } from '../format';

const W = 108;
const H = 14;
const HALF = W / 2;
const BAR_Y = 3;
const BAR_H = 8;
const R = 4;

/** Rounded at the data end, square at the zero baseline (mark spec). */
function barPath(len: number, dir: 1 | -1): string {
  const l = Math.max(len, 0.5);
  const r = Math.min(R, l);
  const y0 = BAR_Y;
  const y1 = BAR_Y + BAR_H;
  if (dir === 1) {
    const xEnd = HALF + l;
    return `M ${HALF} ${y0} H ${xEnd - r} A ${r} ${r} 0 0 1 ${xEnd} ${y0 + r} V ${y1 - r} A ${r} ${r} 0 0 1 ${xEnd - r} ${y1} H ${HALF} Z`;
  }
  const xEnd = HALF - l;
  return `M ${HALF} ${y0} H ${xEnd + r} A ${r} ${r} 0 0 0 ${xEnd} ${y0 + r} V ${y1 - r} A ${r} ${r} 0 0 0 ${xEnd + r} ${y1} H ${HALF} Z`;
}

/**
 * Signed horizontal bar centered on 0. Positive gap (PM richer) extends right
 * in the Polymarket hue; negative (Kalshi richer) extends left in the Kalshi
 * hue. The number rides beside it in ink, never in the data color.
 */
export function GapBar({ gap, scale }: { gap: number | undefined; scale: number }) {
  const label = fmtSignedCents(gap);
  if (gap === undefined) {
    return <span className="gap-cell gap-empty">—</span>;
  }
  const frac = Math.min(Math.abs(gap) / scale, 1);
  const len = frac * (HALF - 2);
  const dir: 1 | -1 = gap >= 0 ? 1 : -1;
  return (
    <span className="gap-cell" title={`PM mid − Kalshi mid = ${label}`}>
      <svg
        className="gap-svg"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        aria-hidden="true"
        focusable="false"
      >
        <line x1={HALF} y1={0} x2={HALF} y2={H} stroke="var(--baseline)" strokeWidth={1} />
        {len > 0 && (
          <path d={barPath(len, dir)} fill={dir === 1 ? 'var(--pm)' : 'var(--kx)'} />
        )}
      </svg>
      <span className="gap-num">{label}</span>
    </span>
  );
}
