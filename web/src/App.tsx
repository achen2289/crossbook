/**
 * Polyscope — tab-based single-page dashboard over the local API.
 * Tabs are plain client-side state; each tab container owns its fetches
 * and hands data to presentational components.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ApiHandle, OverviewResponse } from './api';
import { SAMPLED_OI_TOOLTIP, api, fmtTime, fmtUsd, useApi } from './api';
import { ErrorBox, SectionStatus, Skeleton, TableSkeleton } from './components/Badge';
import { AccountPanel } from './components/AccountPanel';
import { CompareTable } from './components/CompareTable';
import { EventDetail } from './components/EventDetail';
import { EventTable } from './components/EventTable';
import { MoversTable } from './components/MoversTable';
import { ScannerTable } from './components/ScannerTable';
import { StatTile } from './components/StatTile';

type Tab = 'overview' | 'explorer' | 'scanner' | 'compare' | 'movers' | 'account';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'explorer', label: 'Explorer' },
  { id: 'scanner', label: 'Scanner' },
  { id: 'compare', label: 'Cross-Venue' },
  { id: 'movers', label: 'Movers' },
  { id: 'account', label: 'Account' },
];

const isTab = (v: string): v is Tab => TABS.some((t) => t.id === v);

/** Tabs are deep-linkable: #scanner, #compare, ... */
const initialTab = (): Tab => {
  const h = window.location.hash.replace('#', '');
  return isTab(h) ? h : 'overview';
};

export default function App() {
  const [tab, setTabState] = useState<Tab>(initialTab);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const overview = useApi(api.overview, [], 60_000);

  const setTab = (t: Tab) => {
    setTabState(t);
    window.history.replaceState(null, '', `#${t}`);
  };

  const openEvent = (slug: string) => {
    setSelectedEvent(slug);
    setTab('explorer');
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">POLYSCOPE</span>
          <span className="brand-sub">Polymarket US market intelligence · read-only</span>
        </div>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`tab${tab === t.id ? ' tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="content">
        {tab === 'overview' && <OverviewTab overview={overview} onOpenEvent={openEvent} />}
        {tab === 'explorer' && (
          <ExplorerTab
            overview={overview.data}
            selected={selectedEvent}
            onSelect={setSelectedEvent}
          />
        )}
        {tab === 'scanner' && <ScannerTab onOpenEvent={openEvent} />}
        {tab === 'compare' && <CompareTab />}
        {tab === 'movers' && <MoversTab onOpenEvent={openEvent} />}
        {tab === 'account' && <AccountTab />}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function OverviewTab({
  overview,
  onOpenEvent,
}: {
  overview: ApiHandle<OverviewResponse>;
  onOpenEvent: (slug: string) => void;
}) {
  const { data, loading, error, refreshing, reload } = overview;
  if (loading) {
    return (
      <div className="tab-body">
        <div className="tile-grid">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={72} />
          ))}
        </div>
        <TableSkeleton rows={10} />
      </div>
    );
  }
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return null;

  const maxCat = Math.max(...data.categories.map((c) => c.openInterest), 1);
  return (
    <div className={`tab-body${refreshing ? ' is-refreshing' : ''}`}>
      <SectionStatus asOf={data.asOf} refreshing={refreshing} auto="60s" onRefresh={reload} />
      {error && <ErrorBox message={`Refresh failed: ${error}`} onRetry={reload} />}
      <div className="tile-grid">
        <StatTile
          label="Open interest (sampled)"
          value={fmtUsd(data.totals.openInterest)}
          sub={`${data.totals.sampledMarkets.toLocaleString('en-US')} markets sampled`}
          title={SAMPLED_OI_TOOLTIP}
        />
        <StatTile label="Active events" value={data.totals.events.toLocaleString('en-US')} />
        <StatTile label="Markets" value={data.totals.markets.toLocaleString('en-US')} />
        <StatTile label="Live events" value={data.totals.liveEvents.toLocaleString('en-US')} />
      </div>
      <section>
        <h2 title={SAMPLED_OI_TOOLTIP}>Open interest (sampled) by category</h2>
        <div className="cat-bars">
          {data.categories.map((c) => (
            <div key={c.category} className="cat-row">
              <span className="cat-name" title={c.category}>
                {c.category}
              </span>
              <span className="cat-track">
                <span
                  className="cat-fill"
                  style={{ width: `${(c.openInterest / maxCat) * 100}%` }}
                />
              </span>
              <span className="cat-val">{fmtUsd(c.openInterest)}</span>
              <span className="cat-count">{c.events} ev</span>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2 title={SAMPLED_OI_TOOLTIP}>Top events by open interest (sampled)</h2>
        <EventTable events={data.topEvents} onSelect={onOpenEvent} />
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Explorer                                                            */
/* ------------------------------------------------------------------ */

type SortKey = 'openInterest' | 'endDate' | 'markets' | 'featured';

function ExplorerTab({
  overview,
  selected,
  onSelect,
}: {
  overview?: OverviewResponse;
  selected: string | null;
  onSelect: (slug: string | null) => void;
}) {
  const [category, setCategory] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('openInterest');

  useEffect(() => {
    const id = window.setTimeout(() => setQ(qInput.trim()), 300);
    return () => window.clearTimeout(id);
  }, [qInput]);

  const events = useApi(
    () => api.events({ category: category || undefined, q: q || undefined, sort, limit: 100 }),
    [category, q, sort],
  );
  const categories = useMemo(
    () => (overview?.categories ?? []).map((c) => c.category),
    [overview],
  );

  return (
    <div className="tab-body">
      <div className="filters" role="group" aria-label="Event filters">
        <input
          className="input"
          type="search"
          placeholder="Search event titles…"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          aria-label="Search event titles"
        />
        <select
          className="input"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Category"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort by"
        >
          <option value="openInterest">Sort: open interest (sampled)</option>
          <option value="endDate">Sort: end date</option>
          <option value="markets">Sort: market count</option>
          <option value="featured">Sort: featured</option>
        </select>
        {events.data && (
          <span className="dim filters-count">
            {events.data.events.length} of {events.data.total} events
          </span>
        )}
      </div>
      <div className={`explorer${selected ? ' has-detail' : ''}`}>
        <div className={`explorer-list${events.refreshing ? ' is-refreshing' : ''}`}>
          {events.loading ? (
            <TableSkeleton rows={12} />
          ) : events.error && !events.data ? (
            <ErrorBox message={events.error} onRetry={events.reload} />
          ) : events.data ? (
            <EventTable
              events={events.data.events}
              onSelect={(s) => onSelect(s)}
              selectedSlug={selected}
            />
          ) : null}
        </div>
        {selected && (
          <div className="explorer-detail">
            <EventDetail key={selected} slug={selected} onClose={() => onSelect(null)} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Scanner                                                             */
/* ------------------------------------------------------------------ */

function ScannerTab({ onOpenEvent }: { onOpenEvent: (slug: string) => void }) {
  const [all, setAll] = useState(false);
  const scan = useApi(() => api.scan(all), [all], 60_000);
  return (
    <div className="tab-body">
      <p className="explainer">
        <strong>LONG</strong> = buy every outcome for under $1 all-in (requires the outcome set to
        be exhaustive — gate Σmid ≥ 0.95). <strong>SHORT</strong> = sell every outcome for over $1
        net (requires outcomes to be mutually exclusive, not nested — gate Σmid ≤ 1.05). Fees:
        taker θ·p·(1−p), θ=0.06. Verify legs before acting.
      </p>
      <div className="filters">
        <div className="seg" role="group" aria-label="Scan scope">
          <button
            className={`seg-btn${!all ? ' seg-active' : ''}`}
            onClick={() => setAll(false)}
            aria-pressed={!all}
          >
            Only actionable
          </button>
          <button
            className={`seg-btn${all ? ' seg-active' : ''}`}
            onClick={() => setAll(true)}
            aria-pressed={all}
          >
            All partitions
          </button>
        </div>
        {scan.data && (
          <span className="dim filters-count">
            {scan.data.groups.length} groups · {scan.data.scanned} candidates scanned · universe{' '}
            {scan.data.universe} events
          </span>
        )}
      </div>
      <SectionStatus
        asOf={scan.data?.asOf}
        refreshing={scan.refreshing}
        auto="60s"
        onRefresh={scan.reload}
      />
      {scan.error && (
        <ErrorBox
          message={scan.data ? `Refresh failed: ${scan.error}` : scan.error}
          onRetry={scan.reload}
        />
      )}
      <div className={scan.refreshing ? 'is-refreshing' : undefined}>
        {scan.loading ? (
          <TableSkeleton rows={10} />
        ) : scan.data ? (
          <ScannerTable groups={scan.data.groups} onSelectEvent={onOpenEvent} />
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cross-venue                                                         */
/* ------------------------------------------------------------------ */

function CompareTab() {
  const cmp = useApi(api.compare, []);
  return (
    <div className="tab-body">
      <p className="explainer">
        Same-outcome quotes on Polymarket US vs Kalshi. Matching is fuzzy and title-based — treat
        it as a review queue, not ground truth. Venue rules differ (settlement source, deadlines,
        rounding), which alone can explain persistent gaps.
      </p>
      <SectionStatus
        asOf={cmp.data?.asOf}
        refreshing={cmp.refreshing}
        onRefresh={cmp.reload}
        note={
          cmp.data
            ? `${cmp.data.matches.length} matches from ${cmp.data.pmEvents} PM / ${cmp.data.kalshiEvents} Kalshi events`
            : undefined
        }
      />
      {cmp.error && (
        <ErrorBox
          message={cmp.data ? `Refresh failed: ${cmp.error}` : cmp.error}
          onRetry={cmp.reload}
        />
      )}
      <div className={cmp.refreshing ? 'is-refreshing' : undefined}>
        {cmp.loading ? (
          <TableSkeleton rows={10} />
        ) : cmp.data ? (
          <CompareTable matches={cmp.data.matches} />
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Movers                                                              */
/* ------------------------------------------------------------------ */

const WINDOWS = [
  { label: '15m', ms: 900_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '2h', ms: 7_200_000 },
];

function MoversTab({ onOpenEvent }: { onOpenEvent: (slug: string) => void }) {
  const [windowMs, setWindowMs] = useState(3_600_000);
  const movers = useApi(() => api.movers(windowMs), [windowMs], 60_000);
  return (
    <div className="tab-body">
      <div className="filters">
        <div className="seg" role="group" aria-label="Move window">
          {WINDOWS.map((w) => (
            <button
              key={w.ms}
              className={`seg-btn${windowMs === w.ms ? ' seg-active' : ''}`}
              onClick={() => setWindowMs(w.ms)}
              aria-pressed={windowMs === w.ms}
            >
              {w.label}
            </button>
          ))}
        </div>
        {movers.data && (
          <span className="dim filters-count">
            sampling since {fmtTime(movers.data.trackingSince)}
          </span>
        )}
      </div>
      <SectionStatus
        asOf={movers.data?.asOf}
        refreshing={movers.refreshing}
        auto="60s"
        onRefresh={movers.reload}
        note="sampled while the server runs — the public API has no history endpoint"
      />
      {movers.error && (
        <ErrorBox
          message={movers.data ? `Refresh failed: ${movers.error}` : movers.error}
          onRetry={movers.reload}
        />
      )}
      <div className={movers.refreshing ? 'is-refreshing' : undefined}>
        {movers.loading ? (
          <TableSkeleton rows={8} />
        ) : movers.data ? (
          <MoversTable movers={movers.data.movers} onSelectEvent={onOpenEvent} />
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Account                                                             */
/* ------------------------------------------------------------------ */

function AccountTab() {
  const account = useApi(api.account, []);
  if (account.loading) {
    return (
      <div className="tab-body">
        <TableSkeleton rows={6} />
      </div>
    );
  }
  if (account.error && !account.data) {
    return (
      <div className="tab-body">
        <ErrorBox message={account.error} onRetry={account.reload} />
      </div>
    );
  }
  if (!account.data) return null;
  return (
    <div className="tab-body">
      <AccountPanel account={account.data} />
    </div>
  );
}
