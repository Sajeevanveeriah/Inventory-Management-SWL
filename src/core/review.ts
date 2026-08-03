import type { ComparisonRow } from './compare';
import { isApprovable, isExcludable, type DecisionState } from './statuses';

/** Operator decisions keyed by stable row id. */
export interface RowDecision {
  state: DecisionState;
  reason?: string;
}
export type DecisionMap = Record<string, RowDecision>;

export interface HistoryEntry {
  label: string;
  at: string;
}

/** Undo/redo model: snapshots of the decision map with a described action. */
export interface ReviewState {
  decisions: DecisionMap;
  past: { decisions: DecisionMap; entry: HistoryEntry }[];
  future: { decisions: DecisionMap; entry: HistoryEntry }[];
  history: HistoryEntry[];
}

export const EMPTY_REVIEW: ReviewState = { decisions: {}, past: [], future: [], history: [] };

export function decisionFor(state: ReviewState, rowId: string): RowDecision {
  return state.decisions[rowId] ?? { state: 'none' };
}

function push(state: ReviewState, decisions: DecisionMap, label: string): ReviewState {
  const entry: HistoryEntry = { label, at: new Date().toISOString() };
  return {
    decisions,
    past: [...state.past, { decisions: state.decisions, entry }],
    future: [],
    history: [...state.history, entry],
  };
}

/** Approve rows. Silently skips rows that are not approvable — bulk approval
 *  can therefore never include ambiguous or invalid records. Returns the new
 *  state and the count actually approved. */
export function approveRows(
  state: ReviewState,
  rows: ComparisonRow[],
  label?: string,
): { state: ReviewState; approved: number; skipped: number } {
  const next: DecisionMap = { ...state.decisions };
  let approved = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!isApprovable(row.status)) {
      skipped += 1;
      continue;
    }
    next[row.id] = { state: 'approved' };
    approved += 1;
  }
  if (approved === 0) return { state, approved, skipped };
  return {
    state: push(state, next, label ?? `Approved ${approved} record${approved === 1 ? '' : 's'}`),
    approved,
    skipped,
  };
}

export function excludeRows(
  state: ReviewState,
  rows: ComparisonRow[],
  reason: string,
  label?: string,
): { state: ReviewState; excluded: number; skipped: number } {
  const next: DecisionMap = { ...state.decisions };
  let excluded = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!isExcludable(row.status)) {
      skipped += 1;
      continue;
    }
    next[row.id] = { state: 'excluded', reason };
    excluded += 1;
  }
  if (excluded === 0) return { state, excluded, skipped };
  return {
    state: push(
      state,
      next,
      label ?? `Excluded ${excluded} record${excluded === 1 ? '' : 's'}: ${reason}`,
    ),
    excluded,
    skipped,
  };
}

export function clearDecision(state: ReviewState, rows: ComparisonRow[]): ReviewState {
  const next: DecisionMap = { ...state.decisions };
  let changed = 0;
  for (const row of rows) {
    if (next[row.id] !== undefined) {
      delete next[row.id];
      changed += 1;
    }
  }
  if (changed === 0) return state;
  return push(state, next, `Cleared ${changed} decision${changed === 1 ? '' : 's'}`);
}

export function resetAllDecisions(state: ReviewState): ReviewState {
  if (Object.keys(state.decisions).length === 0 && state.past.length === 0) return state;
  return push(state, {}, 'Reset all review decisions');
}

export function undo(state: ReviewState): ReviewState {
  const last = state.past[state.past.length - 1];
  if (last === undefined) return state;
  return {
    decisions: last.decisions,
    past: state.past.slice(0, -1),
    future: [{ decisions: state.decisions, entry: last.entry }, ...state.future],
    history: [
      ...state.history,
      { label: `Undid: ${last.entry.label}`, at: new Date().toISOString() },
    ],
  };
}

export function redo(state: ReviewState): ReviewState {
  const next = state.future[0];
  if (next === undefined) return state;
  return {
    decisions: next.decisions,
    past: [...state.past, { decisions: state.decisions, entry: next.entry }],
    future: state.future.slice(1),
    history: [
      ...state.history,
      { label: `Redid: ${next.entry.label}`, at: new Date().toISOString() },
    ],
  };
}

/**
 * Carry decisions forward after the comparison is re-run. A decision survives
 * only if the row still exists with the same status and proposed price;
 * everything else is dropped (and the operator is warned beforehand).
 */
export function carryDecisionsForward(
  state: ReviewState,
  oldRows: ComparisonRow[],
  newRows: ComparisonRow[],
): { review: ReviewState; kept: number; dropped: number } {
  const oldById = new Map(oldRows.map((r) => [r.id, r]));
  const newById = new Map(newRows.map((r) => [r.id, r]));
  const carried: DecisionMap = {};
  let kept = 0;
  let dropped = 0;
  for (const [rowId, decision] of Object.entries(state.decisions)) {
    if (decision.state === 'none') continue;
    const oldRow = oldById.get(rowId);
    const newRow = newById.get(rowId);
    if (
      oldRow !== undefined &&
      newRow !== undefined &&
      oldRow.status === newRow.status &&
      oldRow.proposedSell === newRow.proposedSell &&
      (oldRow.supplier?.cost ?? null) === (newRow.supplier?.cost ?? null)
    ) {
      carried[rowId] = decision;
      kept += 1;
    } else {
      dropped += 1;
    }
  }
  return {
    review: {
      decisions: carried,
      past: [],
      future: [],
      history: [
        ...state.history,
        {
          label: `Comparison re-run: kept ${kept} decision${kept === 1 ? '' : 's'}, reset ${dropped}`,
          at: new Date().toISOString(),
        },
      ],
    },
    kept,
    dropped,
  };
}
