/**
 * Explorer detail panel for one event: outcome rows with probability bars
 * and bid/ask/spread, per-market expandable order books (depth chart +
 * top-of-book table + BBO stats), and the event's partition-scan groups.
 */
import { useMemo, useState } from 'react';
import type { BookLevel, PmMarket } from '../api';
import {
  SAMPLED_OI_TOOLTIP,
  api,
  fmtCents,
  fmtDate,
  fmtQty,
  marketQuotes,
  marketTitle,
  quotePx,
  useApi,
} from '../api';
import { Badge, ErrorBox, Skeleton, TableSkeleton } from './Badge';
import { DepthChart } from './DepthChart';
import { ProbBar } from './ProbBar';
import { ScannerTable } from './ScannerTable';

const MAX_OUTCOMES = 40;
const BOOK_LEVELS_SHOWN = 5;

export function EventDetail({ slug, onClose }: { slug: string; onClose: () => void }) {
  const detail = useApi(() => api.event(slug), [slug]);

  const markets = useMemo(() => {
    const ms = (detail.data?.event.markets ?? []).filter(
      (m) => m.active !== false && m.closed !== true,
    );
    return [...ms].sort((a, b) => (marketQuotes(b).mid ?? 0) - (marketQuotes(a).mid ?? 0));
  }, [detail.data]);

  if (detail.loading) {
    return (
      <div className="detail">
        <div className="detail-head">
          <Skeleton width="70%" height={20} />
          <button className="btn detail-close" onClick={onClose} aria-label="Close detail">
            ×
          </button>
        </div>
        <TableSkeleton rows={8} />
      </div>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <div className="detail">
        <div className="detail-head">
          <span className="detail-title">Event detail</span>
          <button className="btn detail-close" onClick={onClose} aria-label="Close detail">
            ×
          </button>
        </div>
        <ErrorBox message={detail.error ?? 'No data returned.'} onRetry={detail.reload} />
      </div>
    );
  }

  const ev = detail.data.event;
  const shown = markets.slice(0, MAX_OUTCOMES);

  return (
    <div className={`detail${detail.refreshing ? ' is-refreshing' : ''}`}>
      <div className="detail-head">
        <h2 className="detail-title">{ev.title}</h2>
        <button className="btn detail-close" onClick={onClose} aria-label="Close detail">
          ×
        </button>
      </div>
      <div className="detail-meta">
        <Badge tone="accent">{ev.category ?? 'other'}</Badge>
        {ev.live && <Badge tone="live">live</Badge>}
        <span>ends {fmtDate(ev.endDate)}</span>
      </div>
      <div className="kv-row">
        <span className="kv">
          <span className="kv-k">Outcomes</span>
          <span className="kv-v">{markets.length}</span>
        </span>
      </div>

      <section>
        <h3>Outcomes</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Outcome</th>
              <th>Prob (mid)</th>
              <th className="num">Bid</th>
              <th className="num">Ask</th>
              <th className="num">Spread</th>
              <th className="num">Book</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <MarketRow key={m.slug} market={m} />
            ))}
          </tbody>
        </table>
        {markets.length > MAX_OUTCOMES && (
          <div className="empty-note">
            Showing top {MAX_OUTCOMES} of {markets.length} outcomes by mid.
          </div>
        )}
      </section>

      <section>
        <h3>Partition scan</h3>
        <p className="dim scan-note">
          Σask / Σbid across each mutually exclusive outcome group; net edges include taker fees.
        </p>
        <ScannerTable groups={detail.data.scan} showEvent={false} />
      </section>
    </div>
  );
}

function MarketRow({ market }: { market: PmMarket }) {
  const [open, setOpen] = useState(false);
  const { bid, ask, mid, spread } = marketQuotes(market);
  return (
    <>
      <tr
        className="row-click"
        onClick={() => setOpen((o) => !o)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setOpen((o) => !o);
        }}
        aria-expanded={open}
      >
        <td>
          <div className="cell-title">{marketTitle(market)}</div>
        </td>
        <td>
          <ProbBar value={mid} />
        </td>
        <td className="num">{fmtCents(bid)}</td>
        <td className="num">{fmtCents(ask)}</td>
        <td className="num">{fmtCents(spread)}</td>
        <td className="num">
          <span className="chev">{open ? '▾' : '▸'}</span>
        </td>
      </tr>
      {open && (
        <tr className="expand-row">
          <td colSpan={6}>
            <BookView slug={market.slug} />
          </td>
        </tr>
      )}
    </>
  );
}

function BookView({ slug }: { slug: string }) {
  const book = useApi(() => api.book(slug), [slug]);
  if (book.loading) {
    return (
      <div className="book-view">
        <Skeleton height={140} />
      </div>
    );
  }
  if (book.error || !book.data) {
    return <ErrorBox message={book.error ?? 'No book data.'} onRetry={book.reload} />;
  }
  const { book: b, bbo } = book.data;
  const bestBid = quotePx(bbo.bestBid);
  const bestAsk = quotePx(bbo.bestAsk);
  const mid =
    bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk;
  const topBids = (b.bids ?? []).slice(0, BOOK_LEVELS_SHOWN);
  const topAsks = (b.asks ?? []).slice(0, BOOK_LEVELS_SHOWN);
  const ladderRows = Math.max(topBids.length, topAsks.length);

  return (
    <div className="book-view">
      <DepthChart bids={b.bids} asks={b.asks} mid={mid} />
      <dl className="bbo-grid">
        <div>
          <dt>Last trade</dt>
          <dd>{fmtCents(quotePx(bbo.lastTradePx))}</dd>
        </div>
        <div>
          <dt>Current</dt>
          <dd>{fmtCents(quotePx(bbo.currentPx))}</dd>
        </div>
        <div>
          <dt>Best bid / ask</dt>
          <dd>
            {fmtCents(bestBid)} / {fmtCents(bestAsk)}
          </dd>
        </div>
        <div>
          <dt title={SAMPLED_OI_TOOLTIP}>Open interest (sampled)</dt>
          <dd>{bbo.openInterest !== undefined ? fmtQty(bbo.openInterest) : '—'}</dd>
        </div>
        <div>
          <dt>Bid levels</dt>
          <dd>
            {(b.bids ?? []).length}
            {bbo.bidDepth !== undefined ? ` (depth ${fmtQty(bbo.bidDepth)})` : ''}
          </dd>
        </div>
        <div>
          <dt>Ask levels</dt>
          <dd>
            {(b.asks ?? []).length}
            {bbo.askDepth !== undefined ? ` (depth ${fmtQty(bbo.askDepth)})` : ''}
          </dd>
        </div>
      </dl>
      {ladderRows > 0 && (
        <table className="table table-inner book-table">
          <thead>
            <tr>
              <th className="num">Bid qty</th>
              <th className="num">Bid</th>
              <th className="num">Ask</th>
              <th className="num">Ask qty</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: ladderRows }, (_, i) => {
              const bl: BookLevel | undefined = topBids[i];
              const al: BookLevel | undefined = topAsks[i];
              return (
                <tr key={i}>
                  <td className="num">{bl ? fmtQty(bl.qty) : ''}</td>
                  <td className="num">{bl ? fmtCents(quotePx(bl.px)) : ''}</td>
                  <td className="num">{al ? fmtCents(quotePx(al.px)) : ''}</td>
                  <td className="num">{al ? fmtQty(al.qty) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
