/**
 * Account panel — strictly read-only. Balance tiles plus defensive
 * renderers for positions/open-orders (shapes may vary by API version):
 * we look for the first array of objects, tabulate its scalar keys, and
 * fall back to pretty-printed JSON if the shape is unrecognizable.
 */
import type { AccountResponse, Balance } from '../api';
import { fmtUsd, num } from '../api';
import { StatTile } from './StatTile';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function findRows(value: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(value)) return value.filter(isObj);
  if (isObj(value)) {
    for (const v of Object.values(value)) {
      if (Array.isArray(v)) return v.filter(isObj);
    }
    for (const v of Object.values(value)) {
      if (isObj(v)) {
        const nested = findRows(v);
        if (nested) return nested;
      }
    }
  }
  return undefined;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isObj(v) && typeof v.value === 'string') return v.value; // Quote-like {value, currency}
  try {
    const s = JSON.stringify(v);
    return s.length > 40 ? `${s.slice(0, 40)}…` : s;
  } catch {
    return String(v);
  }
}

function GenericTable({ title, value }: { title: string; value: unknown }) {
  const rows = findRows(value);
  if (!rows || rows.length === 0) {
    return (
      <section className="account-section">
        <h3>{title}</h3>
        {rows && rows.length === 0 ? (
          <div className="empty-note">None.</div>
        ) : value === undefined || value === null ? (
          <div className="empty-note">Not provided by the API.</div>
        ) : (
          <pre className="raw-json">{JSON.stringify(value, null, 2).slice(0, 2000)}</pre>
        )}
      </section>
    );
  }
  const shownRows = rows.slice(0, 50);
  const cols: string[] = [];
  for (const row of shownRows) {
    for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  }
  const shownCols = cols.slice(0, 8);
  return (
    <section className="account-section">
      <h3>
        {title} <span className="dim">({rows.length})</span>
      </h3>
      <table className="table">
        <thead>
          <tr>
            {shownCols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shownRows.map((row, i) => (
            <tr key={i}>
              {shownCols.map((c) => (
                <td key={c} className={typeof row[c] === 'number' ? 'num' : undefined}>
                  {cellText(row[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function AccountPanel({ account }: { account: AccountResponse }) {
  if (!account.authenticated) {
    return (
      <div className="hint-card">
        <h3>Public-data mode</h3>
        <p>
          The server is running without Polymarket US API credentials, so balances, positions,
          and open orders are unavailable. Everything else on this dashboard works without them.
        </p>
        <p>
          To enable this panel, copy <code>.env.example</code> to <code>.env</code>, fill in{' '}
          <code>PMUS_KEY_ID</code> and <code>PMUS_SECRET</code> (generated in your Polymarket US
          developer settings), and restart the server.
        </p>
        <p className="dim">Polyscope is read-only: it never places, modifies, or cancels orders.</p>
      </div>
    );
  }
  const balances: Balance[] = account.balances?.balances ?? [];
  const b: Balance | undefined = balances[0];
  return (
    <div className="account">
      {b ? (
        <div className="tile-grid">
          <StatTile label={`Cash (${b.currency ?? 'USD'})`} value={fmtUsd(num(b.currentBalance))} />
          <StatTile label="Buying power" value={fmtUsd(num(b.buyingPower))} />
          <StatTile label="Asset notional" value={fmtUsd(num(b.assetNotional))} />
          <StatTile label="Open orders" value={fmtUsd(num(b.openOrders))} />
          <StatTile label="Unsettled funds" value={fmtUsd(num(b.unsettledFunds))} />
        </div>
      ) : (
        <div className="empty-note">No balances returned.</div>
      )}
      <GenericTable title="Positions" value={account.positions} />
      <GenericTable title="Open orders" value={account.openOrders} />
      <p className="dim">Read-only view — Polyscope has no order entry.</p>
    </div>
  );
}
