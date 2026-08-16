/**
 * Small shared primitives: Badge, Skeleton, TableSkeleton, ErrorBox,
 * and the SectionStatus "as of" line used by every auto-refreshing tab.
 */
import type { ReactNode } from 'react';
import { fmtTime } from '../api';

export type BadgeTone = 'long' | 'short' | 'none' | 'live' | 'neutral' | 'accent';

export function Badge({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: BadgeTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Skeleton({
  width = '100%',
  height = 14,
}: {
  width?: number | string;
  height?: number | string;
}) {
  return <div className="skeleton" style={{ width, height }} aria-hidden="true" />;
}

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={22} width={`${100 - (i % 3) * 6}%`} />
      ))}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <span className="error-title">Request failed</span>
      <span className="error-msg">{message}</span>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function SectionStatus({
  asOf,
  refreshing,
  auto,
  note,
  onRefresh,
}: {
  asOf?: string;
  refreshing?: boolean;
  auto?: string;
  note?: string;
  onRefresh?: () => void;
}) {
  return (
    <div className="section-status">
      {asOf && (
        <span>
          as of <strong>{fmtTime(asOf)}</strong>
        </span>
      )}
      {auto && <span className="dim">auto-refresh {auto}</span>}
      {note && <span className="dim">{note}</span>}
      {refreshing && <span className="pulse" title="Refreshing" aria-label="Refreshing" />}
      {onRefresh && (
        <button className="btn btn-ghost" onClick={onRefresh}>
          Refresh
        </button>
      )}
    </div>
  );
}
