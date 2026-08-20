import { describe, expect, it } from 'vitest';
import { buildAuditText } from './audit';
import { runComparison } from './compare';
import { deriveTaxConvention } from './conventions';
import { extractS8Records, extractSupplierRecords } from './records';
import type { ParsedTable } from './table';

function table(name: string, headers: string[], rows: string[][]): ParsedTable {
  return {
    fileName: name,
    fileType: 'csv',
    byteSize: 100,
    sha256: 'abc123',
    sheetNames: ['CSV data'],
    selectedSheet: 'CSV data',
    headers,
    rows,
    warnings: [],
  };
}

describe('buildAuditText', () => {
  it('contains rules, totals, hashes, decisions and outputs - but no raw rows', () => {
    const supplierTable = table(
      'DEMO-supplier.csv',
      ['Code', 'Name', 'Cost'],
      [
        ['A-1', 'Fictional Widget SecretDescription', '100.00'],
        ['A-2', 'Fictional Other', '5.00'],
      ],
    );
    const s8Table = table(
      'DEMO-s8.csv',
      ['Item', 'Desc', 'Cost', 'Sell', 'Price Includes Taxes'],
      [
        ['A-1', 'Fictional Widget', '90.00', '117.00', 'No'],
        ['A-2', 'Fictional Other', '5.00', '6.50', 'No'],
      ],
    );
    const s8Records = extractS8Records(s8Table, {
      itemNumber: 0,
      itemDescription: 1,
      existingCost: 2,
      existingSellPrice: 3,
      priceIncludesTaxes: 4,
    });
    const comparison = runComparison(
      extractSupplierRecords(supplierTable, {
        supplierCode: 0,
        supplierDescription: 1,
        supplierCost: 2,
      }),
      s8Records,
      new Map(),
      {
        markupPercent: '30',
        costBasis: 'excluding-gst',
        costBasisConfirmed: true,
        newItemConvention: deriveTaxConvention(s8Records),
      },
    );
    const changedRow = comparison.rows.find((r) => r.status === 'price-changed');
    expect(changedRow).toBeDefined();

    const text = buildAuditText({
      runId: 'RUN123',
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:05Z',
      supplierTable,
      s8Table,
      profileName: 'Test profile',
      profileVersion: 2,
      comparison,
      decisions: {
        [changedRow?.id ?? '']: { state: 'approved' },
      },
      taxHandling: 'Supplier costs exclude GST',
      newItemConvention: 'Price excludes GST, tax rate “GST on Income”',
      importFormat: 'ServiceM8 Materials & Services CSV - canonical column contract',
      settingsChanges: [{ at: '2026-01-01T00:00:01Z', change: 'markup changed 30% → 30%' }],
      outputFilenames: ['20260101-Test_import-candidate_run-RUN123.xlsx'],
    });

    expect(text).toContain('RUN123');
    expect(text).toContain('30% on GST-exclusive supplier cost');
    expect(text).toContain('product override > brand blanket > global default');
    expect(text).toContain('Round half up to 2 decimal places');
    expect(text).toContain('abc123'); // input hash
    expect(text).toContain('Exact identifier match:  2');
    expect(text).toContain('Price changed:           1');
    expect(text).toContain('[PRICE] A-1');
    expect(text).toContain('AUD 100.00');
    expect(text).toContain('import-candidate');
    // The audit report must not embed full raw descriptions of unapproved rows.
    expect(text).not.toContain('SecretDescription');
  });
});
