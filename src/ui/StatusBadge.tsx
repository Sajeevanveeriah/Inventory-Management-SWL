import type { BaseStatus, DecisionState } from '../core/statuses';
import { STATUS_LABELS } from '../core/statuses';

export function StatusBadge({ status }: { status: BaseStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status]}</span>;
}

export function DecisionBadge({ decision }: { decision: DecisionState }) {
  if (decision === 'approved') return <span className="badge badge-approved">Approved</span>;
  if (decision === 'excluded') return <span className="badge badge-excluded">Excluded</span>;
  return null;
}
