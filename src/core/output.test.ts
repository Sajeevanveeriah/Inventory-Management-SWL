import { describe, expect, it } from 'vitest';
import type { ComparisonResult, ComparisonRow } from './compare';
import type { SupplierRecord } from './records';
import { buildReleaseChecklist, checklistPasses, rowsForImport } from './output';
import type { BaseStatus } from './statuses';
import type { DecisionMap } from './review';
import { SERVICEM8_COLUMNS, matchServiceM8Layout } from './servicem8Format';

function supplier(code: string, cost: string | null): SupplierRecord {
  return {
    rowIndex: 0,
    sourceRow: 2,
    code,
    codeNorm: code.toUpperCase(),
    description: `Fictional ${code}`,
    costRaw: cost ?? '',
    cost,
    barcode: '',
    priceOnApplication: false,
    issues: [],
  };
}

function row(
  id: string,
  status: BaseStatus,
  cost: string | null = '10.00',
  proposedSell: string | null = '13.00',
): ComparisonRow {
  return {
    id,
    status,
    matchMethod: 'exact-code',
    supplier: supplier(id, cost),
    s8: null,
    proposedSell,
    targetBasis: proposedSell === null ? null : 'excluding-gst',
    pricing:
      cost === null || proposedSell === null
        ? null
        : {
            costExGst: cost,
            sellExGst: proposedSell,
            sellIncGst: proposedSell,
            price: proposedSell,
            purchaseCost: cost,
            explanation: 'test fixture',
          },
    costDelta: null,
    priceDelta: null,
    duplicateSourceRows: [],
    messages: [],
    suggestions: [],
  };
}

function comparison(rows: ComparisonRow[]): ComparisonResult {
  return {
    rows,
    totals: {
      supplierRecords: rows.length,
      s8Records: 0,
      exactMatches: 0,
      aliasMatches: 0,
      unchanged: 0,
      priceChanged: 0,
      newItems: 0,
      missingFromSupplier: 0,
      ambiguous: 0,
      invalid: 0,
      duplicates: 0,
      duplicatesCollapsed: 0,
      blocked: 0,
    },
    markupPercent: '30',
    costBasis: 'excluding-gst',
    costBasisConfirmed: true,
    newItemConvention: {
      includesTaxes: false,
      taxRate: 'GST on Income',
      support: 0,
      total: 0,
      fallback: true,
      inconsistent: 0,
    },
  };
}

const LAYOUT = matchServiceM8Layout([...SERVICEM8_COLUMNS]);

describe('rowsForImport', () => {
  it('includes only approved price-changed and new-item rows', () => {
    const rows = [
      row('approved-change', 'price-changed'),
      row('approved-new', 'new-item'),
      row('not-approved', 'price-changed'),
      row('unchanged', 'unchanged'),
      row('missing', 'missing-from-supplier'),
    ];
    const decisions: DecisionMap = {
      'approved-change': { state: 'approved' },
      'approved-new': { state: 'approved' },
      unchanged: { state: 'approved' }, // even if somehow approved, filtered by status
      missing: { state: 'approved' },
    };
    const out = rowsForImport(rows, decisions);
    expect(out.map((r) => r.id).sort()).toEqual(['approved-change', 'approved-new']);
  });

  it('hard-blocks ambiguous and invalid rows even if a decision says approved', () => {
    const rows = [row('amb', 'ambiguous'), row('inv', 'invalid')];
    const decisions: DecisionMap = {
      amb: { state: 'approved' },
      inv: { state: 'approved' },
    };
    expect(rowsForImport(rows, decisions)).toHaveLength(0);
  });

  it('excludes excluded rows and rows without a usable price', () => {
    const rows = [
      row('excluded', 'price-changed'),
      row('no-price', 'price-changed', '10.00', null),
      row('no-cost', 'price-changed', null),
    ];
    const decisions: DecisionMap = {
      excluded: { state: 'excluded', reason: 'test' },
      'no-price': { state: 'approved' },
      'no-cost': { state: 'approved' },
    };
    expect(rowsForImport(rows, decisions)).toHaveLength(0);
  });
});

describe('buildReleaseChecklist', () => {
  const base = {
    mappingComplete: true,
    layout: LAYOUT,
    markupPercent: '30',
    taxHandling: 'Supplier costs exclude GST',
  };

  it('passes with a clean approved set', () => {
    const rows = [row('a', 'price-changed')];
    const gates = buildReleaseChecklist({
      ...base,
      comparison: comparison(rows),
      decisions: { a: { state: 'approved' } },
    });
    expect(checklistPasses(gates)).toBe(true);
  });

  it('fails when nothing is approved', () => {
    const gates = buildReleaseChecklist({
      ...base,
      comparison: comparison([row('a', 'price-changed')]),
      decisions: {},
    });
    expect(checklistPasses(gates)).toBe(false);
    expect(gates.find((g) => g.id === 'approvals')?.ok).toBe(false);
  });

  it('fails when an ambiguous or invalid record carries an approval', () => {
    const rows = [row('amb', 'ambiguous'), row('ok', 'price-changed')];
    const gates = buildReleaseChecklist({
      ...base,
      comparison: comparison(rows),
      decisions: { amb: { state: 'approved' }, ok: { state: 'approved' } },
    });
    expect(gates.find((g) => g.id === 'no-approved-ambiguous')?.ok).toBe(false);
    expect(checklistPasses(gates)).toBe(false);
  });

  it('fails on duplicate output identifiers', () => {
    const rows = [
      row('a', 'price-changed'),
      { ...row('a2', 'price-changed'), supplier: supplier('a', '9.00') },
    ];
    const gates = buildReleaseChecklist({
      ...base,
      comparison: comparison(rows),
      decisions: { a: { state: 'approved' }, a2: { state: 'approved' } },
    });
    expect(gates.find((g) => g.id === 'no-duplicate-ids')?.ok).toBe(false);
  });

  it('fails when mappings are incomplete', () => {
    const gates = buildReleaseChecklist({
      ...base,
      mappingComplete: false,
      comparison: comparison([row('a', 'price-changed')]),
      decisions: { a: { state: 'approved' } },
    });
    expect(gates.find((g) => g.id === 'mappings')?.ok).toBe(false);
    expect(checklistPasses(gates)).toBe(false);
  });
});
