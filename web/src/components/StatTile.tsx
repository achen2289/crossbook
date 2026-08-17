import { fmtInt } from '../format';

export function StatTile({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{fmtInt(value)}</div>
    </div>
  );
}

export function StatTileSkeleton() {
  return (
    <div className="tile" aria-hidden="true">
      <div className="skeleton skeleton-text" style={{ width: '60%' }} />
      <div className="skeleton skeleton-value" style={{ width: '40%' }} />
    </div>
  );
}
