/**
 * ScanGroup table with expandable leg rows. Used full-width on the Scanner
 * tab and (with showEvent=false) inside the Explorer event detail panel.
 */
import { Fragment, useState } from 'react';
import type { ScanGroup } from '../api';
import { fmtCents, fmtCents2, fmtEdge, fmtSum } from '../api';
import { Badge } from './Badge';

const COLS = 9;

/** Edges are -1 sentinels when a side is unquotable (missing bid/ask). */
const isSentinel = (v: number): boolean => v === -1;
const fmtEdgeOrNa = (v: number): string => (isSentinel(v) ? 'n/a' : fmtEdge(v));

export function ScannerTable({
  groups,
  showEvent = true,
  onSelectEvent,
}: {
  groups: ScanGroup[];
  showEvent?: boolean;
  onSelectEvent?: (slug: string) => void;
}) {
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (groups.length === 0) return <div className="empty-note">No partition groups found.</div>;

  return (
    <table className="table">
      <thead>
        <tr>
          <th>{showEvent ? 'Event / group' : 'Group'}</th>
          <th className="num">Legs</th>
          <th className="num">Σ ask</th>
          <th className="num">Σ bid</th>
          <th className="num">Σ mid</th>
          <th className="num">Long net</th>
          <th className="num">Short net</th>
          <th className="num">Exec sets</th>
          <th>Kind</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g, i) => {
          const key = `${g.eventSlug}::${g.groupTitle}::${i}`;
          const open = openKeys.has(key);
          const exec =
            g.kind === 'long'
              ? g.executableLongSets
              : g.kind === 'short'
                ? g.executableShortSets
                : undefined;
          return (
            <Fragment key={key}>
              <tr
                className="row-click"
                onClick={() => toggle(key)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') toggle(key);
                }}
                aria-expanded={open}
              >
                <td>
                  <div className="cell-title">
                    <span className="chev">{open ? '▾' : '▸'}</span>
                    {showEvent ? g.eventTitle : g.groupTitle}{' '}
                    {g.refreshed && (
                      <Badge
                        tone="accent"
                        title="Legs re-priced from live order-book tops (not embedded quotes)"
                      >
                        book-verified
                      </Badge>
                    )}
                  </div>
                  {showEvent && g.groupTitle !== g.eventTitle && (
                    <div className="cell-sub">{g.groupTitle}</div>
                  )}
                  {showEvent && <div className="cell-sub">{g.eventCategory ?? 'other'}</div>}
                </td>
                <td className="num">{g.legCount}</td>
                <td className="num">{fmtSum(g.sumAsk)}</td>
                <td className="num">{fmtSum(g.sumBid)}</td>
                <td className="num">{fmtSum(g.sumMid)}</td>
                <td className={`num ${!isSentinel(g.longEdgeNet) && g.longEdgeNet > 0 ? 'pos' : 'dim'}`}>
                  {fmtEdgeOrNa(g.longEdgeNet)}
                </td>
                <td className={`num ${!isSentinel(g.shortEdgeNet) && g.shortEdgeNet > 0 ? 'pos' : 'dim'}`}>
                  {fmtEdgeOrNa(g.shortEdgeNet)}
                </td>
                <td className="num">{exec !== undefined ? `×${Math.floor(exec)}` : '—'}</td>
                <td>
                  <Badge tone={g.kind}>{g.kind}</Badge>
                </td>
              </tr>
              {open && (
                <tr className="expand-row">
                  <td colSpan={COLS}>
                    <div className="legs-wrap">
                      <div className="legs-meta">
                        <span>
                          gross: long {fmtEdgeOrNa(g.longEdgeGross)} / short{' '}
                          {fmtEdgeOrNa(g.shortEdgeGross)}
                        </span>
                        <span>partition score {g.partitionScore.toFixed(3)}</span>
                        <span>{g.complete ? 'complete quotes' : 'incomplete quotes'}</span>
                        {onSelectEvent && (
                          <button
                            className="btn btn-ghost"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectEvent(g.eventSlug);
                            }}
                          >
                            Open event →
                          </button>
                        )}
                      </div>
                      <table className="table table-inner">
                        <thead>
                          <tr>
                            <th>Outcome</th>
                            <th className="num">Bid</th>
                            <th className="num">Ask</th>
                            <th className="num">Mid</th>
                            <th className="num" title="Per-market taker fee coefficient">
                              θ
                            </th>
                            <th className="num">Fee @ ask</th>
                            <th className="num">Fee @ bid</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.legs.map((leg) => (
                            <tr key={leg.marketSlug}>
                              <td>{leg.title}</td>
                              <td className="num">{fmtCents(leg.bid)}</td>
                              <td className="num">{fmtCents(leg.ask)}</td>
                              <td className="num">{fmtCents(leg.mid)}</td>
                              <td className="num">{leg.theta.toFixed(2)}</td>
                              <td className="num">{fmtCents2(leg.feeAtAsk)}</td>
                              <td className="num">{fmtCents2(leg.feeAtBid)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
