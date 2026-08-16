/** Dense event table shared by Overview (top events) and Explorer. */
import type { EventSummary, TopMarket } from '../api';
import { SAMPLED_OI_TOOLTIP, fmtUsd } from '../api';
import { Badge } from './Badge';
import { ProbBar } from './ProbBar';

export function EventTable({
  events,
  onSelect,
  selectedSlug,
}: {
  events: EventSummary[];
  onSelect: (slug: string) => void;
  selectedSlug?: string | null;
}) {
  if (events.length === 0) return <div className="empty-note">No events match.</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Event</th>
          <th className="num" title={SAMPLED_OI_TOOLTIP}>
            Open interest (sampled)
          </th>
          <th className="num">Mkts</th>
          <th>Top outcome</th>
        </tr>
      </thead>
      <tbody>
        {events.map((ev) => {
          const top: TopMarket | undefined = ev.topMarkets[0];
          return (
            <tr
              key={ev.slug}
              className={`row-click${selectedSlug === ev.slug ? ' row-selected' : ''}`}
              onClick={() => onSelect(ev.slug)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSelect(ev.slug);
              }}
            >
              <td>
                <div className="cell-title">
                  {ev.title} {ev.live && <Badge tone="live">live</Badge>}
                </div>
                <div className="cell-sub">{ev.category ?? 'other'}</div>
              </td>
              <td className="num" title={SAMPLED_OI_TOOLTIP}>
                {ev.openInterest !== undefined ? fmtUsd(ev.openInterest) : '—'}
              </td>
              <td className="num">{ev.marketCount}</td>
              <td>
                {top ? (
                  <div className="cell-outcome">
                    <span className="cell-outcome-title" title={top.title}>
                      {top.title}
                    </span>
                    <ProbBar value={top.mid} />
                  </div>
                ) : (
                  <span className="dim">—</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
