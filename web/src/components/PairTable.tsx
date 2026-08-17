import { useMemo, useState } from 'react';
import type { PairQuote } from '../api';
import { COL_COUNT, PairRow } from './PairRow';

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }, (_, i) => (
        <tr key={i} className="pair-row" aria-hidden="true">
          <td className="q-cell">
            <span className="skeleton skeleton-text" style={{ width: `${55 - (i % 3) * 10}%` }} />
            <span className="skeleton skeleton-text" style={{ width: `${35 - (i % 2) * 8}%` }} />
          </td>
          <td><span className="skeleton skeleton-text" style={{ width: 48 }} /></td>
          <td className="num"><span className="skeleton skeleton-text" style={{ width: 64 }} /></td>
          <td className="num"><span className="skeleton skeleton-text" style={{ width: 64 }} /></td>
          <td className="num"><span className="skeleton skeleton-text" style={{ width: 96 }} /></td>
          <td className="num"><span className="skeleton skeleton-text" style={{ width: 56 }} /></td>
        </tr>
      ))}
    </>
  );
}

export function PairTable({
  pairs,
  loading,
  dimmed,
}: {
  pairs: PairQuote[];
  loading: boolean;
  dimmed: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const gapScale = useMemo(() => {
    let max = 0;
    for (const p of pairs) {
      if (p.gap !== undefined) max = Math.max(max, Math.abs(p.gap));
    }
    return Math.max(max, 0.05);
  }, [pairs]);

  return (
    <div className={`table-wrap${dimmed ? ' dimmed' : ''}`}>
      <table className="pair-table">
        <thead>
          <tr>
            <th scope="col" className="t-left">Question</th>
            <th scope="col" className="t-left">Trust</th>
            <th scope="col" title="Polymarket YES bid / ask, cents">PM yes bid/ask (¢)</th>
            <th scope="col" title="Kalshi YES bid / ask, cents">KX yes bid/ask (¢)</th>
            <th scope="col" title="PM mid − Kalshi mid">Gap (PM − KX)</th>
            <th scope="col" title="Best guaranteed profit per $1 contract set after taker fees">Edge</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows />
          ) : pairs.length === 0 ? (
            <tr>
              <td colSpan={COL_COUNT} className="empty-cell">
                no pairs match the current filters
              </td>
            </tr>
          ) : (
            pairs.map((p) => (
              <PairRow
                key={p.id}
                pair={p}
                gapScale={gapScale}
                expanded={expandedId === p.id}
                onToggle={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
