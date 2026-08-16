/**
 * Cross-venue match table: Polymarket vs Kalshi mids with a signed
 * divergence bar (blue = PM richer, orange = Kalshi richer — a warm/cool
 * diverging pair; the sign is also printed, so color never stands alone).
 */
import type { MarketMatch } from '../api';
import { fmtCents, fmtEdge, fmtPct } from '../api';
import { Badge } from './Badge';

export function CompareTable({ matches }: { matches: MarketMatch[] }) {
  if (matches.length === 0) {
    return <div className="empty-note">No cross-venue matches found.</div>;
  }
  const maxAbs = Math.max(...matches.map((m) => Math.abs(m.divergence)), 0.01);
  return (
    <>
      <div className="chart-legend">
        <span className="legend-key">
          <span className="swatch swatch-pm" />
          Polymarket richer (+)
        </span>
        <span className="legend-key">
          <span className="swatch swatch-kalshi" />
          Kalshi richer (−)
        </span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Polymarket outcome</th>
            <th className="num">PM mid</th>
            <th className="div-col">Divergence</th>
            <th className="num">KX mid</th>
            <th>Kalshi outcome</th>
            <th className="num">Conf</th>
          </tr>
        </thead>
        <tbody>
          {matches.map((m) => {
            const w = Math.min(100, (Math.abs(m.divergence) / maxAbs) * 100);
            return (
              <tr
                key={`${m.pm.id}::${m.kalshi.id}`}
                className={m.suspect ? 'row-suspect' : undefined}
              >
                <td>
                  <div className="cell-title">
                    {m.pm.title}{' '}
                    {m.suspect && (
                      <Badge
                        tone="neutral"
                        title="Divergence this large is usually a semantic mismatch (e.g. a spread fuzzy-matched to a moneyline), not a real cross-venue gap"
                      >
                        suspect match
                      </Badge>
                    )}
                  </div>
                  <div className="cell-sub">{m.pm.eventTitle}</div>
                </td>
                <td className="num">{fmtCents(m.pm.mid)}</td>
                <td>
                  <div className="divbar" role="img" aria-label={`divergence ${fmtEdge(m.divergence)}`}>
                    <span className="divbar-half">
                      {m.divergence < 0 && (
                        <span className="divbar-fill fill-kalshi" style={{ width: `${w}%` }} />
                      )}
                    </span>
                    <span className="divbar-axis" />
                    <span className="divbar-half">
                      {m.divergence > 0 && (
                        <span className="divbar-fill fill-pm" style={{ width: `${w}%` }} />
                      )}
                    </span>
                  </div>
                  <div className="divbar-num">{fmtEdge(m.divergence)}</div>
                </td>
                <td className="num">{fmtCents(m.kalshi.mid)}</td>
                <td>
                  <div className="cell-title">{m.kalshi.title}</div>
                  <div className="cell-sub">{m.kalshi.eventTitle}</div>
                </td>
                <td className="num">{fmtPct(m.confidence, 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
