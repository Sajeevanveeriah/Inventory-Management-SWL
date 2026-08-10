import { describe, expect, it } from 'vitest';
import type { ComparisonRow } from './compare';
import {
  EMPTY_REVIEW,
  approveRows,
  carryDecisionsForward,
  excludeRows,
  redo,
  resetAllDecisions,
  undo,
} from './review';
import type { BaseStatus } from './statuses';

function row(id: string, status: BaseStatus, proposedSell: string | null = '13.00'): ComparisonRow {
  return {
    id,
    status,
    matchMethod: 'exact-code',
    supplier: null,
    s8: null,
    proposedSell,
    targetBasis: 'excluding-gst',
    pricing: null,
    costDelta: null,
    priceDelta: null,
    duplicateSourceRows: [],
    messages: [],
    suggestions: [],
  };
}

describe('approveRows', () => {
  it('approves price-changed and new-item rows', () => {
    const rows = [row('a', 'price-changed'), row('b', 'new-item')];
    const { state, approved, skipped } = approveRows(EMPTY_REVIEW, rows);
    expect(approved).toBe(2);
    expect(skipped).toBe(0);
    expect(state.decisions.a?.state).toBe('approved');
    expect(state.committedApprovals).toEqual({ a: true, b: true });
  });

  it('does not publish the same approval twice in one review', () => {
    const first = approveRows(EMPTY_REVIEW, [row('a', 'price-changed')]).state;
    const repeated = approveRows(first, [row('a', 'price-changed')]);
    expect(repeated.approved).toBe(0);
    expect(repeated.skipped).toBe(1);
    expect(repeated.state).toBe(first);
  });

  it('never approves ambiguous, invalid, unchanged or missing rows (bulk safety)', () => {
    const rows = [
      row('amb', 'ambiguous'),
      row('inv', 'invalid'),
      row('unc', 'unchanged'),
      row('mis', 'missing-from-supplier'),
      row('ok', 'price-changed'),
    ];
    const { state, approved, skipped } = approveRows(EMPTY_REVIEW, rows);
    expect(approved).toBe(1);
    expect(skipped).toBe(4);
    expect(state.decisions.amb).toBeUndefined();
    expect(state.decisions.inv).toBeUndefined();
    expect(state.decisions.unc).toBeUndefined();
    expect(state.decisions.mis).toBeUndefined();
    expect(state.decisions.ok?.state).toBe('approved');
  });
});

describe('excludeRows', () => {
  it('records the exclusion reason', () => {
    const { state } = excludeRows(EMPTY_REVIEW, [row('x', 'price-changed')], 'No longer stocked');
    expect(state.decisions.x).toEqual({
      state: 'excluded',
      reason: 'No longer stocked',
    });
  });

  it('skips non-excludable rows', () => {
    const { excluded, skipped } = excludeRows(EMPTY_REVIEW, [row('x', 'invalid')], 'reason');
    expect(excluded).toBe(0);
    expect(skipped).toBe(1);
  });
});

describe('undo/redo/reset', () => {
  it('supports undo and redo of exclusions while preserving recorded approvals', () => {
    const approved = approveRows(EMPTY_REVIEW, [row('a', 'price-changed')]).state;
    const excluded = excludeRows(approved, [row('b', 'price-changed')], 'Not stocked').state;
    const undone = undo(excluded);
    expect(undone.decisions.a?.state).toBe('approved');
    expect(undone.decisions.b).toBeUndefined();
    const redone = redo(undone);
    expect(redone.decisions.a?.state).toBe('approved');
    expect(redone.decisions.b?.state).toBe('excluded');
  });

  it('reset clears only reversible decisions and remains undoable', () => {
    const approved = approveRows(EMPTY_REVIEW, [row('a', 'price-changed')]).state;
    const excluded = excludeRows(approved, [row('b', 'price-changed')], 'Not stocked').state;
    const reset = resetAllDecisions(excluded);
    expect(reset.decisions).toEqual({ a: { state: 'approved' } });
    const restored = undo(reset);
    expect(restored.decisions.a?.state).toBe('approved');
    expect(restored.decisions.b?.state).toBe('excluded');
  });

  it('records a history of actions', () => {
    const approved = approveRows(EMPTY_REVIEW, [row('a', 'price-changed')]).state;
    const excluded = excludeRows(approved, [row('b', 'price-changed')], 'Not stocked').state;
    expect(undo(excluded).history.length).toBeGreaterThanOrEqual(3);
  });
});

describe('carryDecisionsForward', () => {
  it('keeps decisions for rows whose status and prices are unchanged', () => {
    const oldRows = [row('a', 'price-changed', '13.00')];
    const s1 = approveRows(EMPTY_REVIEW, oldRows).state;
    const { review, kept, dropped } = carryDecisionsForward(s1, oldRows, [
      row('a', 'price-changed', '13.00'),
    ]);
    expect(kept).toBe(1);
    expect(dropped).toBe(0);
    expect(review.decisions.a?.state).toBe('approved');
  });

  it('drops decisions when the proposed price changed', () => {
    const oldRows = [row('a', 'price-changed', '13.00')];
    const s1 = approveRows(EMPTY_REVIEW, oldRows).state;
    const { review, kept, dropped } = carryDecisionsForward(s1, oldRows, [
      row('a', 'price-changed', '14.30'),
    ]);
    expect(kept).toBe(0);
    expect(dropped).toBe(1);
    expect(review.decisions.a).toBeUndefined();
  });

  it('drops decisions for rows that no longer exist', () => {
    const oldRows = [row('a', 'price-changed')];
    const s1 = approveRows(EMPTY_REVIEW, oldRows).state;
    const { dropped } = carryDecisionsForward(s1, oldRows, []);
    expect(dropped).toBe(1);
  });
});
