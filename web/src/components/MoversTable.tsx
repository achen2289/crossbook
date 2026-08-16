/** Largest |Δmid| moves, with signed arrow + color delta chips. */
import type { Mover } from '../api';
import { fmtAgo, fmtDelta, fmtPct } from '../api';

export function MoversTable({
  movers,
  onSelectEvent,
}: {
  movers: Mover[];
  onSelectEvent?: (slug: string) => void;
}) {
  if (movers.length === 0) {
    return (
      <div className="empty-note">
        No moves recorded yet — the tracker samples prices while the server runs, so give it a
        few minutes.
      </div>
    );
  }
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Outcome</th>
          <th className="num">Prev</th>
          <th className="num">Now</th>
          <th className="num">Δ mid</th>
          <th className="num">Observed over</th>
        </tr>
      </thead>
      <tbody>
        {movers.map((m) => (
          <tr
            key={m.marketSlug}
            className={onSelectEvent ? 'row-click' : undefined}
            onClick={onSelectEvent ? () => onSelectEvent(m.eventSlug) : undefined}
            tabIndex={onSelectEvent ? 0 : undefined}
            onKeyDown={
              onSelectEvent
                ? (e) => {
                    if (e.key === 'Enter') onSelectEvent(m.eventSlug);
                  }
                : undefined
            }
          >
            <td>
              <div className="cell-title">{m.title}</div>
              <div className="cell-sub">{m.eventTitle}</div>
            </td>
            <td className="num">{fmtPct(m.prevMid)}</td>
            <td className="num">{fmtPct(m.mid)}</td>
            <td className="num">
              <span className={`chip ${m.delta >= 0 ? 'chip-up' : 'chip-down'}`}>
                {m.delta >= 0 ? '▲' : '▼'} {fmtDelta(m.delta)}
              </span>
            </td>
            <td className="num">{fmtAgo(m.sinceMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
