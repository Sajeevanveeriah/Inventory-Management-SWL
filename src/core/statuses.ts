/** Base status assigned deterministically by the comparison engine. */
export type BaseStatus =
  'unchanged' | 'price-changed' | 'new-item' | 'missing-from-supplier' | 'ambiguous' | 'invalid';

/** Operator decision layered on top of the base status. */
export type DecisionState = 'none' | 'approved' | 'excluded';

export const STATUS_LABELS: Record<BaseStatus, string> = {
  unchanged: 'Unchanged',
  'price-changed': 'Price changed',
  'new-item': 'New item',
  'missing-from-supplier': 'Missing from supplier',
  ambiguous: 'Ambiguous',
  invalid: 'Invalid',
};

export const STATUS_DESCRIPTIONS: Record<BaseStatus, string> = {
  unchanged: 'No material update is required. Excluded from the import output by default.',
  'price-changed':
    'Supplier cost differs from the existing ServiceM8 cost. A new price is proposed.',
  'new-item': 'The supplier identifier is absent from ServiceM8. Requires explicit approval.',
  'missing-from-supplier':
    'The ServiceM8 item is absent from the supplier file. Flagged only — never deleted automatically.',
  ambiguous: 'Multiple or uncertain matches exist. Blocked from the import output.',
  invalid: 'A required value is missing or malformed. Blocked from the import output.',
};

/** Only these base statuses may ever be approved for the import output. */
const APPROVABLE: ReadonlySet<BaseStatus> = new Set(['price-changed', 'new-item']);

export function isApprovable(status: BaseStatus): boolean {
  return APPROVABLE.has(status);
}

/** Statuses that are hard-blocked from the import output. */
export function isBlocked(status: BaseStatus): boolean {
  return status === 'ambiguous' || status === 'invalid';
}

/** Statuses the operator may exclude with a reason. */
export function isExcludable(status: BaseStatus): boolean {
  return APPROVABLE.has(status);
}
