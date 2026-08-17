export type BadgeVariant = 'curated' | 'high' | 'low' | 'live' | 'suspect' | 'verified';

const LABELS: Record<BadgeVariant, string> = {
  curated: 'curated',
  high: 'high',
  low: 'review',
  live: 'LIVE',
  suspect: 'suspect',
  verified: 'book-verified',
};

const TITLES: Record<BadgeVariant, string> = {
  curated: 'Hand-verified slug-to-ticker mapping',
  high: 'Near-exact title match on event and outcome',
  low: 'Loose fuzzy match — gap shown for review, no arb math',
  live: 'In-play on the Polymarket side — apparent edges are usually staleness',
  suspect: 'Likely question mismatch or too-good-to-be-true',
  verified: 'Quotes and edges re-derived from live order books',
};

export function Badge({ variant }: { variant: BadgeVariant }) {
  return (
    <span className={`badge badge-${variant}`} title={TITLES[variant]}>
      {LABELS[variant]}
    </span>
  );
}
