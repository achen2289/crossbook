export type TrustFilter = 'all' | 'curated' | 'trusted';

interface FiltersProps {
  query: string;
  onQuery: (q: string) => void;
  trust: TrustFilter;
  onTrust: (t: TrustFilter) => void;
  showSuspect: boolean;
  onShowSuspect: (v: boolean) => void;
}

const CHIPS: { key: TrustFilter; label: string; title: string }[] = [
  { key: 'all', label: 'All', title: 'Every matched pair' },
  { key: 'curated', label: 'Curated', title: 'Hand-verified mappings only' },
  { key: 'trusted', label: 'Trusted', title: 'Curated + high-confidence title matches' },
];

export function Filters({ query, onQuery, trust, onTrust, showSuspect, onShowSuspect }: FiltersProps) {
  return (
    <div className="filters" role="group" aria-label="Filters">
      <input
        className="search"
        type="search"
        placeholder="search question text…"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        aria-label="Search question text"
      />
      <div className="chip-row" role="group" aria-label="Trust filter">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            className="chip-btn"
            aria-pressed={trust === c.key}
            title={c.title}
            onClick={() => onTrust(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <label className="suspect-toggle" title="Suspect = likely question mismatch or too-good-to-be-true">
        <input
          type="checkbox"
          checked={showSuspect}
          onChange={(e) => onShowSuspect(e.target.checked)}
        />
        show suspect matches
      </label>
    </div>
  );
}
