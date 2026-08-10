import { describe, expect, it } from 'vitest';
import { deriveTaxConvention, describeTaxConvention } from './conventions';
import { extractS8Records } from './records';
import type { ParsedTable } from './table';

const HEADERS = ['Item Number', 'Name', 'Price', 'Price Includes Taxes', 'Tax Rate'];
const MAPPING = {
  itemNumber: 0,
  itemDescription: 1,
  existingSellPrice: 2,
  priceIncludesTaxes: 3,
  taxRate: 4,
};

function records(rows: string[][]) {
  const table: ParsedTable = {
    fileName: 'fixture.csv',
    fileType: 'csv',
    byteSize: 1,
    sha256: 'x',
    sheetNames: ['CSV data'],
    selectedSheet: 'CSV data',
    headers: HEADERS,
    rows,
    warnings: [],
  };
  return extractS8Records(table, MAPPING);
}

describe('deriveTaxConvention', () => {
  it('adopts the convention the account already uses most often', () => {
    const convention = deriveTaxConvention(
      records([
        ['A', 'One', '10', 'No', 'GST on Income'],
        ['B', 'Two', '20', 'No', 'GST on Income'],
        ['C', 'Three', '30', 'Yes', ''],
      ]),
    );
    expect(convention.includesTaxes).toBe(false);
    expect(convention.taxRate).toBe('GST on Income');
    expect(convention.support).toBe(2);
    expect(convention.total).toBe(3);
    expect(convention.fallback).toBe(false);
  });

  it('counts rows whose basis and rate contradict each other', () => {
    const convention = deriveTaxConvention(
      records([
        ['A', 'One', '10', 'No', 'GST on Income'],
        ['B', 'Two', '20', 'Yes', ''],
        ['C', 'Three', '30', 'Yes', ''],
      ]),
    );
    // Two rows carry a price but no tax rate at all.
    expect(convention.inconsistent).toBe(2);
  });

  it('breaks a tie towards the pair that records a tax rate', () => {
    const convention = deriveTaxConvention(
      records([
        ['A', 'One', '10', 'Yes', ''],
        ['B', 'Two', '20', 'No', 'GST on Income'],
      ]),
    );
    expect(convention.taxRate).toBe('GST on Income');
    expect(convention.includesTaxes).toBe(false);
  });

  it('falls back to a documented, internally consistent pair when there is nothing to read', () => {
    const convention = deriveTaxConvention([]);
    expect(convention.fallback).toBe(true);
    expect(convention.includesTaxes).toBe(false);
    expect(convention.taxRate).toBe('GST on Income');
    expect(describeTaxConvention(convention)).toContain('documented fallback');
  });

  it('ignores rows that are already invalid', () => {
    const convention = deriveTaxConvention(
      records([
        ['A', 'One', '10', 'No', 'GST on Income'],
        // No price at all: this row cannot vote.
        ['B', 'Two', '', 'Yes', ''],
        ['C', 'Three', '', 'Yes', ''],
      ]),
    );
    expect(convention.total).toBe(1);
    expect(convention.includesTaxes).toBe(false);
  });

  it('describes itself with the evidence behind it', () => {
    const convention = deriveTaxConvention(
      records([
        ['A', 'One', '10', 'Yes', 'GST on Income'],
        ['B', 'Two', '20', 'Yes', 'GST on Income'],
      ]),
    );
    expect(describeTaxConvention(convention)).toBe(
      'Price includes GST, GST on Income (used by 2 of 2 existing ServiceM8 items).',
    );
  });
});
