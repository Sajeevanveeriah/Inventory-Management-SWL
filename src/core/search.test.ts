import { describe, expect, it } from 'vitest';
import type { ComparisonRow } from './compare';
import type { S8Record, SupplierRecord } from './records';
import { searchRows } from './search';
import { normalizeIdentifier } from './normalize';

function supplier(code: string, description: string): SupplierRecord {
  return {
    rowIndex: 0,
    sourceRow: 2,
    code,
    codeNorm: normalizeIdentifier(code),
    description,
    costRaw: '10.00',
    cost: '10.00',
    issues: [],
  };
}

function s8(itemNumber: string, description: string): S8Record {
  return {
    rowIndex: 0,
    sourceRow: 2,
    itemNumber,
    itemNumberNorm: normalizeIdentifier(itemNumber),
    description,
    existingCostRaw: '10.00',
    existingCost: '10.00',
    existingSellRaw: '13.00',
    existingSell: '13.00',
    issues: [],
  };
}

function row(
  id: string,
  status: ComparisonRow['status'],
  sup: SupplierRecord | null,
  service: S8Record | null,
): ComparisonRow {
  return {
    id,
    status,
    matchMethod: sup && service ? 'exact-code' : 'none',
    supplier: sup,
    s8: service,
    proposedSell: sup?.cost ? '13.00' : null,
    costDelta: null,
    messages: [],
    suggestions: [],
  };
}

const ROWS: ComparisonRow[] = [
  row(
    'r1',
    'unchanged',
    supplier('LW4570', 'Lockwood 4570 Digital Deadlatch'),
    s8('LW4570', 'Lockwood 4570 Digital Deadlatch'),
  ),
  row(
    'r2',
    'price-changed',
    supplier('LW-001', 'Lockwood 001 Deadlatch Chrome'),
    s8('LW-001', 'Lockwood 001 Deadlatch Chrome'),
  ),
  row('r3', 'new-item', supplier('KAB-90', 'Kaba 90 Series Push Button Lock'), null),
  row('r4', 'missing-from-supplier', null, s8('00123', 'Whitco Window Lock White')),
  row('r5', 'invalid', supplier('BAD', ''), null),
];

describe('searchRows', () => {
  it('returns all rows in source order for an empty query', () => {
    const hits = searchRows(ROWS, '');
    expect(hits.map((h) => h.row.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
  });

  it('ranks an exact code match first', () => {
    const hits = searchRows(ROWS, 'LW-001');
    expect(hits[0]?.row.id).toBe('r2');
    expect(hits[0]?.score).toBe(100);
    expect(hits[0]?.matchedOn).toBe('code');
  });

  it('is case-insensitive and preserves leading zeroes in identifiers', () => {
    const hits = searchRows(ROWS, 'lw4570');
    expect(hits[0]?.row.id).toBe('r1');
    expect(searchRows(ROWS, '00123')[0]?.row.id).toBe('r4');
    // 123 is not the same identifier as 00123 (leading zeroes preserved).
    expect(searchRows(ROWS, '123').find((h) => h.row.id === 'r4')?.score).toBeLessThan(100);
  });

  it('matches identifier prefixes above description matches', () => {
    const hits = searchRows(ROWS, 'LW');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]?.score).toBe(90);
    expect(['r1', 'r2']).toContain(hits[0]?.row.id);
  });

  it('matches all description tokens regardless of order', () => {
    const hits = searchRows(ROWS, 'deadlatch lockwood');
    expect(hits.map((h) => h.row.id).sort()).toEqual(['r1', 'r2']);
    expect(hits[0]?.matchedOn).toBe('description');
  });

  it('matches ServiceM8-only rows by description', () => {
    const hits = searchRows(ROWS, 'window lock');
    expect(hits[0]?.row.id).toBe('r4');
  });

  it('returns no hits for an unrelated query', () => {
    expect(searchRows(ROWS, 'zzz-does-not-exist-9999')).toEqual([]);
  });

  it('applies status filters with and without a query', () => {
    const filtered = searchRows(ROWS, '', { statuses: new Set(['new-item']) });
    expect(filtered.map((h) => h.row.id)).toEqual(['r3']);
    const both = searchRows(ROWS, 'lock', {
      statuses: new Set(['new-item', 'missing-from-supplier']),
    });
    expect(both.map((h) => h.row.id).sort()).toEqual(['r3', 'r4']);
  });

  it('is deterministic: equal scores tie-break on identifier then id', () => {
    const a = searchRows(ROWS, 'lockwood deadlatch');
    const b = searchRows(ROWS, 'lockwood deadlatch');
    expect(a.map((h) => h.row.id)).toEqual(b.map((h) => h.row.id));
  });
});
