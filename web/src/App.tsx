import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchPairs, fetchStatus } from './api';
import type { PairsResponse, StatusResponse } from './api';
import { fmtAgo, fmtClock } from './format';
import { Filters } from './components/Filters';
import type { TrustFilter } from './components/Filters';
import { PairTable } from './components/PairTable';
import { StatTile, StatTileSkeleton } from './components/StatTile';

const REFRESH_MS = 60_000;

export default function App() {
  const [data, setData] = useState<PairsResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [trust, setTrust] = useState<TrustFilter>('all');
  const [showSuspect, setShowSuspect] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    fetchStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
    try {
      const d = await fetchPairs();
      setData(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const visible = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.pairs.filter((p) => {
      if (!showSuspect && p.suspect) return false;
      if (trust === 'curated' && !p.curated) return false;
      if (trust === 'trusted' && p.trust === 'low') return false;
      if (q) {
        const hay =
          `${p.pm.title} ${p.pm.eventTitle} ${p.kalshi.outcome} ${p.kalshi.eventTitle}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, query, trust, showSuspect]);

  const initialLoading = !data && !error;

  return (
    <div className="app">
      <header className="header">
        <div className="brand-block">
          <span className="brand">CROSSBOOK</span>
          <span className="brand-sub">Polymarket US × Kalshi · read-only</span>
        </div>
        <div className="header-right">
          {status?.authenticated && (
            <span className="status-chip" title="Polymarket US API key authenticated (read-only)">
              PM key active
            </span>
          )}
          {data && (
            <span className="asof" title={data.asOf}>
              as of {fmtClock(data.asOf)} · {fmtAgo(data.asOf, now)}
            </span>
          )}
          <button
            type="button"
            className="refresh-btn"
            onClick={() => void load()}
            disabled={refreshing}
          >
            {refreshing ? 'refreshing…' : 'Refresh'}
          </button>
          <span className="auto-note" title="Auto-refreshes every 60 seconds">auto 60s</span>
        </div>
      </header>

      <p className="explainer">
        Same question, two venues. Gap = PM mid − Kalshi mid. Edge = guaranteed profit per $1
        contract set after both venues' taker fees (PM 0.06·p·(1−p), Kalshi 0.07·p·(1−p) rounded
        up) — buy YES on the cheap venue, NO on the rich one.
      </p>

      {error && (
        <div className="error-banner" role="alert">
          <span className="err-text">
            {data ? 'refresh failed' : 'load failed'} — {error}
          </span>
          <button type="button" className="chip-btn chip-sm" onClick={() => void load()} disabled={refreshing}>
            retry
          </button>
        </div>
      )}

      <div className="tiles">
        {initialLoading ? (
          Array.from({ length: 5 }, (_, i) => <StatTileSkeleton key={i} />)
        ) : (
          <>
            <StatTile label="matched pairs" value={data?.totals.pairs} />
            <StatTile label="curated" value={data?.totals.curated} />
            <StatTile label="actionable now" value={data?.totals.actionable} />
            <StatTile label="PM events" value={data?.totals.pmEvents} />
            <StatTile label="Kalshi events scanned" value={data?.totals.kalshiEvents} />
          </>
        )}
      </div>

      <Filters
        query={query}
        onQuery={setQuery}
        trust={trust}
        onTrust={setTrust}
        showSuspect={showSuspect}
        onShowSuspect={setShowSuspect}
      />

      {error && !data ? (
        <div className="table-error">
          Could not reach the Crossbook server. Is it running on :8787?
        </div>
      ) : (
        <PairTable pairs={visible} loading={initialLoading} dimmed={refreshing && !!data} />
      )}

      <footer className="footer">
        <p>
          Read-only: Crossbook observes prices and never places orders. Matching is fuzzy —
          curated pairs are hand-verified, others are a review queue.
        </p>
        <p>
          Gap history is self-sampled while the server runs; neither venue publishes historical
          prices. Nothing here is investment advice.
        </p>
      </footer>
    </div>
  );
}
