import type { KeyboardEvent } from 'react';
import type { ArbLeg, PairQuote } from '../api';
import { isPhantom } from '../api';
import { fmtCents, fmtCentsBare, fmtSignedCents } from '../format';
import { Badge } from './Badge';
import { GapBar } from './GapBar';
import { GapChart } from './GapChart';

export const COL_COUNT = 6;

const VENUE_NAME: Record<ArbLeg['venue'], string> = {
  polymarket: 'Polymarket',
  kalshi: 'Kalshi',
};

function StrategyCard({
  name,
  desc,
  legs,
  edge,
  isBest,
}: {
  name: 'A' | 'B';
  desc: string;
  legs: ArbLeg[] | undefined;
  edge: number | undefined;
  isBest: boolean;
}) {
  if (!legs || edge === undefined) {
    return (
      <div className="strat strat-unavailable">
        <div className="strat-head">
          <span className="panel-title">Strategy {name}</span>
          <span className="strat-desc">{desc}</span>
        </div>
        <div className="strat-missing">unavailable — missing quote on one leg</div>
      </div>
    );
  }
  const total = legs.reduce((s, l) => s + l.price + l.fee, 0);
  return (
    <div className={`strat${isBest ? ' strat-best' : ''}`}>
      <div className="strat-head">
        <span className="panel-title">Strategy {name}</span>
        <span className="strat-desc">{desc}</span>
        {isBest && <span className="best-tag">best</span>}
      </div>
      <table className="leg-table">
        <thead>
          <tr>
            <th scope="col" className="t-left">venue</th>
            <th scope="col" className="t-left">side</th>
            <th scope="col">price ¢</th>
            <th scope="col">fee ¢</th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => (
            <tr key={`${l.venue}-${l.side}`}>
              <td className="t-left">
                <span
                  className="venue-dot"
                  style={{ background: l.venue === 'polymarket' ? 'var(--pm)' : 'var(--kx)' }}
                  aria-hidden="true"
                />
                {VENUE_NAME[l.venue]}
              </td>
              <td className="t-left">{l.side}</td>
              <td className="num">{fmtCentsBare(l.price, 2)}</td>
              <td className="num">{fmtCentsBare(l.fee, 2)}</td>
            </tr>
          ))}
          <tr className="leg-total">
            <td className="t-left" colSpan={2}>total cost / set</td>
            <td className="num" colSpan={2}>{fmtCents(total, 2)}</td>
          </tr>
          <tr className="leg-total">
            <td className="t-left" colSpan={2}>edge (1 − cost)</td>
            <td className={`num${edge > 0 ? ' pos' : ''}`} colSpan={2}>
              {fmtSignedCents(edge, 2)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function EdgeCell({ pair }: { pair: PairQuote }) {
  const edge = pair.arb.bestEdge;
  if (edge === undefined) {
    return <span className="edge-dim">—</span>;
  }
  const phantom = isPhantom(pair);
  const sets = pair.arb.executableSets;
  const cls = phantom ? 'edge-phantom' : edge > 0 ? 'edge-pos' : 'edge-flat';
  return (
    <span className="edge-cell">
      <span className={cls}>{fmtSignedCents(edge)}</span>
      <span className="edge-sub">
        {phantom && <span className="no-size" title="Book-verified but zero fillable sets — phantom edge on an empty book">no size</span>}
        {!phantom && sets !== undefined && sets > 0 && <span className="sets">×{sets}</span>}
        {pair.refreshed && <Badge variant="verified" />}
      </span>
    </span>
  );
}

interface PairRowProps {
  pair: PairQuote;
  gapScale: number;
  expanded: boolean;
  onToggle: () => void;
}

export function PairRow({ pair, gapScale, expanded, onToggle }: PairRowProps) {
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle();
    }
  };
  const best = pair.arb.best;
  return (
    <>
      <tr
        className={`pair-row${expanded ? ' expanded' : ''}${pair.suspect ? ' suspect-row' : ''}`}
        tabIndex={0}
        role="button"
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={onKey}
      >
        <td className="q-cell">
          <span className={`caret${expanded ? ' open' : ''}`} aria-hidden="true">›</span>
          <span className="q-lines">
            <span className="q-pm">
              <strong>{pair.pm.title}</strong>
              <span className="q-event"> {pair.pm.eventTitle}</span>
            </span>
            <span className="q-kx">
              KX: {pair.kalshi.outcome}
              <span className="q-event"> · {pair.kalshi.eventTitle}</span>
            </span>
          </span>
        </td>
        <td className="badge-cell">
          <Badge variant={pair.trust} />
          {pair.live && <Badge variant="live" />}
          {pair.suspect && <Badge variant="suspect" />}
        </td>
        <td className="num">
          {fmtCentsBare(pair.pm.yesBid)} / {fmtCentsBare(pair.pm.yesAsk)}
        </td>
        <td className="num">
          {fmtCentsBare(pair.kalshi.yesBid)} / {fmtCentsBare(pair.kalshi.yesAsk)}
        </td>
        <td className="num gap-col">
          <GapBar gap={pair.gap} scale={gapScale} />
        </td>
        <td className="num edge-col">
          <EdgeCell pair={pair} />
        </td>
      </tr>
      {expanded && (
        <tr className="detail-row">
          <td colSpan={COL_COUNT}>
            <div className="detail">
              <div className="detail-ids">
                <span title="Polymarket market slug">PM {pair.pm.slug}</span>
                <span title="Kalshi market ticker">KX {pair.kalshi.ticker}</span>
                <span title="Fuzzy-match confidence">confidence {pair.confidence.toFixed(2)}</span>
              </div>
              {pair.trust === 'low' ? (
                <div className="strat-missing">
                  Low-trust match — gap shown for review only; no arb math is computed.
                </div>
              ) : (
                <div className="strats">
                  <StrategyCard
                    name="A"
                    desc="buy YES on Polymarket + buy NO on Kalshi"
                    legs={pair.arb.legsA}
                    edge={pair.arb.edgeA}
                    isBest={best === 'A'}
                  />
                  <StrategyCard
                    name="B"
                    desc="buy YES on Kalshi + buy NO on Polymarket"
                    legs={pair.arb.legsB}
                    edge={pair.arb.edgeB}
                    isBest={best === 'B'}
                  />
                </div>
              )}
              <GapChart pairId={pair.id} />
              <div className="caveat">
                Venue rules can differ (settlement source, deadlines, rounding). Verify both
                contracts before acting.
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
