/** Inline probability bar: hairline track, accent fill, tabular % readout. */
export function ProbBar({ value, width = 64 }: { value?: number; width?: number }) {
  if (value === undefined) return <span className="dim">—</span>;
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span className="probbar" role="img" aria-label={`${pct.toFixed(1)} percent`}>
      <span className="probbar-track" style={{ width }}>
        <span className="probbar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="probbar-num">{pct.toFixed(1)}%</span>
    </span>
  );
}
