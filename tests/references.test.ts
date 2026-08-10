import { describe, expect, it } from 'vitest';
import type { ComparisonResult, ComparisonRow } from '../src/core/compare';
import type { CompetitorObservation } from '../src/core/competitors';
import { normalizeIdentifier } from '../src/core/normalize';
import type { S8Record, SupplierRecord } from '../src/core/records';
import { searchRows } from '../src/core/search';
import { INITIAL_STATE, reducer, type AppState } from '../src/state/store';

const OBSERVATION: CompetitorObservation = {
  sku: 'LW4570',
  sourceName: 'Manual operator entry',
  approvedSource: true,
  observedAt: '2026-08-05T00:00:00.000Z',
  price: '143.00',
  currency: 'AUD',
  gstBasis: 'inc-gst',
  shipping: '0',
  stockStatus: 'unknown',
  condition: 'new',
  packCompatible: true,
  productOnly: true,
  matchConfidence: 1,
  reviewState: 'accepted',
  url: 'https://example.invalid/lw4570',
};

function supplier(code: string, description: string): SupplierRecord {
  return {
    rowIndex: 0,
    sourceRow: 2,
    code,
    codeNorm: normalizeIdentifier(code),
    description,
    costRaw: '100.00',
    cost: '100.00',
    barcode: '',
    priceOnApplication: false,
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
    existingCostRaw: '90.00',
    existingCost: '90.00',
    existingSellRaw: '117.00',
    existingSell: '117.00',
    includesTaxes: false,
    includesTaxesRaw: 'No',
    taxRateRaw: 'GST on Income',
    quantityInStockRaw: '0',
    itemIsInventoriedRaw: 'No',
    barcodeRaw: '',
    issues: [],
  };
}

function row(id: string, code: string, description: string): ComparisonRow {
  return {
    id,
    status: 'price-changed',
    matchMethod: 'exact-code',
    supplier: supplier(code, description),
    s8: s8(code, description),
    proposedSell: '130.00',
    targetBasis: 'excluding-gst',
    pricing: null,
    costDelta: '10.00',
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
      s8Records: rows.length,
      exactMatches: rows.length,
      aliasMatches: 0,
      unchanged: 0,
      priceChanged: rows.length,
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
      support: 1,
      total: 1,
      fallback: false,
      inconsistent: 0,
    },
  };
}

function stateWithComparison(): AppState {
  return {
    ...INITIAL_STATE,
    comparison: comparison([row('r1', 'LW4570', 'Lockwood 4570 Digital Deadlatch')]),
    comparisonStartedAt: '2026-08-05T00:00:00.000Z',
  };
}

describe('competitor reference attachment', () => {
  it('stores the price, source and timestamp for reference only', () => {
    const before = stateWithComparison();
    const after = reducer(before, {
      type: 'reference-attached',
      reference: { rowId: 'r1', observation: OBSERVATION, attachedAt: '2026-08-05T01:00:00.000Z' },
    });
    expect(after.references).toHaveLength(1);
    expect(after.references[0]?.observation.price).toBe('143.00');
    expect(after.references[0]?.observation.sourceName).toBe('Manual operator entry');
    expect(after.references[0]?.attachedAt).toBe('2026-08-05T01:00:00.000Z');
  });

  it('leaves every cost and sell price byte-identical after attaching', () => {
    const before = stateWithComparison();
    const serialisedBefore = JSON.stringify(before.comparison);
    const after = reducer(before, {
      type: 'reference-attached',
      reference: { rowId: 'r1', observation: OBSERVATION, attachedAt: '2026-08-05T01:00:00.000Z' },
    });
    expect(JSON.stringify(after.comparison)).toBe(serialisedBefore);
    expect(after.comparison).toBe(before.comparison);
    expect(after.review).toBe(before.review);
    expect(after.outputs).toBe(before.outputs);
  });

  it('adding evidence never touches the comparison either', () => {
    const before = stateWithComparison();
    const after = reducer(before, { type: 'evidence-added', observations: [OBSERVATION] });
    expect(after.competitorEvidence).toHaveLength(1);
    expect(after.comparison).toBe(before.comparison);
  });
});

describe('catalogue search performance', () => {
  it('searches 20,000 rows within 250 ms', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) =>
      row(`perf-${i}`, `FIC-${i}`, `Fictionville deadlatch variant ${i}`),
    );
    const started = performance.now();
    const hits = searchRows(rows, 'FIC-19999');
    const elapsed = performance.now() - started;
    console.info(`searchRows over 20,000 rows took ${elapsed.toFixed(1)} ms`);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.row.id).toBe('perf-19999');
    expect(elapsed).toBeLessThan(250);
  });
});
