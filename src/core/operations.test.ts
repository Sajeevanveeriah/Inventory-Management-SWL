import { describe, expect, it } from 'vitest';
import {
  buildApprovalProposals,
  buildRunMetadata,
  deriveExceptions,
  parseCompetitorEvidenceRows,
} from './operations';
import { runComparison } from './compare';
import { deriveTaxConvention } from './conventions';
import { extractS8Records, extractSupplierRecords } from './records';
import { parseFile } from '../io/parse';
import {
  DEMO_SERVICEM8_CSV,
  DEMO_SERVICEM8_MAPPING,
  DEMO_SUPPLIER_CSV,
  DEMO_SUPPLIER_MAPPING,
} from '../demo/fixtures';

async function demoComparison() {
  const supplier = await parseFile(
    new File([DEMO_SUPPLIER_CSV], 'supplier.csv', { type: 'text/csv' }),
  );
  const s8 = await parseFile(new File([DEMO_SERVICEM8_CSV], 's8.csv', { type: 'text/csv' }));
  const s8Records = extractS8Records(s8, DEMO_SERVICEM8_MAPPING);
  return runComparison(
    extractSupplierRecords(supplier, DEMO_SUPPLIER_MAPPING),
    s8Records,
    new Map([['ALIAS-11', 'FIC-011']]),
    {
      markupPercent: '30',
      costBasis: 'excluding-gst',
      costBasisConfirmed: true,
      newItemConvention: deriveTaxConvention(s8Records),
    },
  );
}

describe('operations domain', () => {
  it('derives unified exceptions and proposal-only approvals', async () => {
    const comparison = await demoComparison();
    expect(deriveExceptions(comparison).some((e) => e.type === 'ambiguous')).toBe(true);
    const proposals = buildApprovalProposals(comparison, {});
    expect(proposals.some((p) => !p.approvable && p.exceptionState === 'invalid')).toBe(true);
    expect(proposals.some((p) => p.approvable && p.changeCount === 1)).toBe(true);
  });

  it('builds metadata without raw rows', async () => {
    const comparison = await demoComparison();
    const meta = buildRunMetadata({
      comparison,
      decisions: {},
      inputFiles: [
        { filename: 'supplier.csv', sha256: 'a'.repeat(64) },
        { filename: 's8.csv', sha256: 'b'.repeat(64) },
      ],
      outputFilenames: [],
      profileName: 'Demo',
      profileVersion: 1,
    });
    expect(meta.inputFilenames).toEqual(['supplier.csv', 's8.csv']);
    expect(meta.fileHashes).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(JSON.stringify(meta)).not.toContain('Fictionville Deadbolt');
  });

  it('validates local competitor evidence import rows', () => {
    const result = parseCompetitorEvidenceRows([
      {
        sku: '00123',
        sourceName: 'Example',
        price: '143.00',
        gstBasis: 'inc-gst',
        matchConfidence: '0.91',
      },
      { sku: '', sourceName: '', price: '' },
    ]);
    expect(result.observations).toHaveLength(1);
    expect(result.errors[0]).toContain('required');
  });
});
