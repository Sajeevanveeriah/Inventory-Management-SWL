import type { BaseStatus, DecisionState } from '../core/statuses';
import { STATUS_LABELS } from '../core/statuses';

/**
 * Presentation-only short forms for the review grid, where the status column
 * is a fixed 104px and a wrapped or truncated badge would break the row grid.
 * The full wording stays in the accessible name and in the detail panel, so
 * nothing is lost to a screen reader or to the exported reports.
 */
const SHORT_STATUS_LABELS: Record<BaseStatus, string> = {
  unchanged: 'Unchanged',
  'price-changed': 'Changed',
  'new-item': 'New',
  'missing-from-supplier': 'Missing',
  ambiguous: 'Ambiguous',
  invalid: 'Invalid',
};

export function StatusBadge({
  status,
  compact = false,
}: {
  status: BaseStatus;
  compact?: boolean;
}) {
  const label = STATUS_LABELS[status];
  if (!compact) return <span className={`badge badge-${status}`}>{label}</span>;
  return (
    <span className={`badge badge-${status}`} title={label}>
      <span aria-hidden="true">{SHORT_STATUS_LABELS[status]}</span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}

export function DecisionBadge({ decision }: { decision: DecisionState }) {
  if (decision === 'approved') return <span className="badge badge-approved">Approved</span>;
  if (decision === 'excluded') return <span className="badge badge-excluded">Excluded</span>;
  return null;
}
