// @vitest-environment node
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { runComparison } from '../src/core/compare';
import { deriveTaxConvention } from '../src/core/conventions';
import { extractS8Records, extractSupplierRecords } from '../src/core/records';
import { approveRows, excludeRows, EMPTY_REVIEW } from '../src/core/review';
import { buildAllOutputs } from '../src/io/exportWorkbooks';
import { parseFile } from '../src/io/parse';
import {
  DEMO_SERVICEM8_CSV,
  DEMO_SERVICEM8_MAPPING,
  DEMO_SUPPLIER_CSV,
  DEMO_SUPPLIER_MAPPING,
  DEMO_ALIAS,
} from '../src/demo/fixtures';

const SUPPLIER_MAPPING = DEMO_SUPPLIER_MAPPING;
const S8_MAPPING = DEMO_SERVICEM8_MAPPING;

async function demoScenario() {
  const supplierTable = await parseFile(new File([DEMO_SUPPLIER_CSV], 'DEMO-supplier.csv'));
  const s8Table = await parseFile(new File([DEMO_SERVICEM8_CSV], 'DEMO-s8.csv'));
  const s8Records = extractS8Records(s8Table, S8_MAPPING);
  const comparison = runComparison(
    extractSupplierRecords(supplierTable, SUPPLIER_MAPPING),
    s8Records,
    new Map([[DEMO_ALIAS.supplierCode, DEMO_ALIAS.itemNumber]]),
    {
      markupPercent: '30',
      costBasis: 'excluding-gst',
      costBasisConfirmed: true,
      newItemConvention: deriveTaxConvention(s8Records),
    },
  );
  return { supplierTable, s8Table, comparison };
}

/** Minimal RFC4180 reader, used to prove the generated CSV parses back. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function readWorkbook(blob: Blob): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  return wb;
}

function sheetRows(ws: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  ws.eachRow((row) => {
    const cells: string[] = [];
    for (let c = 1; c <= row.cellCount; c += 1) cells.push(row.getCell(c).text);
    rows.push(cells);
  });
  return rows;
}

describe('demo comparison end-to-end statuses', () => {
  it('assigns every expected demo status', async () => {
    const { comparison } = await demoScenario();
    const statusOf = (code: string) =>
      comparison.rows.find(
        (r) => r.supplier?.code === code || (r.supplier === null && r.s8?.itemNumber === code),
      )?.status;

    expect(statusOf('FIC-001')).toBe('unchanged');
    expect(statusOf('FIC-002')).toBe('price-changed'); // increase
    expect(statusOf('FIC-003')).toBe('price-changed'); // decrease
    expect(statusOf('FIC-004')).toBe('new-item');
    expect(statusOf('FIC-900')).toBe('missing-from-supplier');
    expect(statusOf('FIC-006')).toBe('ambiguous'); // description twin of FIC-060
    expect(statusOf('FIC-007')).toBe('invalid'); // missing cost
    expect(statusOf('FIC-008')).toBe('invalid'); // invalid currency
    expect(statusOf('00123')).toBe('price-changed'); // leading zeroes preserved
    expect(statusOf('FIC-010')).toBe('new-item'); // formula-like description, flagged
    expect(statusOf('ALIAS-11')).toBe('price-changed'); // via approved alias
    expect(statusOf('FIC-012')).toBe('price-changed');

    // FIC-005 appears twice at the SAME cost, so the copies are folded into a
    // single proposal rather than blocking the item.
    const foldedRows = comparison.rows.filter((r) => r.supplier?.code === 'FIC-005');
    expect(foldedRows).toHaveLength(1);
    expect(foldedRows[0]?.status).toBe('price-changed');
    expect(foldedRows[0]?.duplicateSourceRows).toHaveLength(1);
    expect(comparison.totals.duplicatesCollapsed).toBe(1);

    // FIC-009 appears twice at DIFFERENT costs, so every copy stays blocked.
    const conflictingRows = comparison.rows.filter((r) => r.supplier?.code === 'FIC-009');
    expect(conflictingRows).toHaveLength(2);
    for (const r of conflictingRows) expect(r.status).toBe('ambiguous');

    // A supplier item marked price-on-application has no cost to mark up.
    expect(statusOf('FIC-013')).toBe('invalid');

    const alias = comparison.rows.find((r) => r.supplier?.code === 'ALIAS-11');
    expect(alias?.matchMethod).toBe('alias');
    const fic010 = comparison.rows.find((r) => r.supplier?.code === 'FIC-010');
    expect(fic010?.messages.some((m) => m.message.includes('neutralised'))).toBe(true);
  });
});

describe('buildAllOutputs', () => {
  it('generates every output, with a ServiceM8 CSV holding only approved valid rows', async () => {
    const { supplierTable, s8Table, comparison } = await demoScenario();
    const fic012 = comparison.rows.find((r) => r.supplier?.code === 'FIC-012');
    let review = excludeRows(EMPTY_REVIEW, [fic012!], 'Fictional exclusion for testing').state;
    const approvable = comparison.rows.filter(
      (r) => (r.status === 'price-changed' || r.status === 'new-item') && r.id !== fic012?.id,
    );
    review = approveRows(review, approvable).state;

    const outputs = await buildAllOutputs({
      comparison,
      decisions: review.decisions,
      supplierTable,
      s8Table,
      s8Mapping: S8_MAPPING,
      profileName: 'Fictionville Demo',
      profileVersion: 1,
      taxHandling: 'Supplier costs exclude GST',
      newItemIncludesTaxes: false,
      newItemTaxRate: 'GST on Income',
      settingsChanges: [],
      startedAt: new Date().toISOString(),
      now: new Date(2026, 7, 3),
    });

    expect(outputs.map((o) => o.kind)).toEqual([
      'import',
      'change-report',
      'exceptions',
      'rollback',
      'audit',
    ]);
    for (const out of outputs) {
      expect(out.filename).toMatch(
        /^20260803-fictionville-demo_[a-z0-9-]+_run-[A-Z0-9]{6}\.(xlsx|txt|csv)$/,
      );
    }
    // All five share the same run id.
    const runIds = new Set(outputs.map((o) => /run-([A-Z0-9]{6})/.exec(o.filename)?.[1]));
    expect(runIds.size).toBe(1);

    // --- ServiceM8 import CSV ---------------------------------------------
    const importCsv = await outputs[0]!.blob.text();
    expect(outputs[0]!.filename.endsWith('.csv')).toBe(true);
    const importRows = parseCsv(importCsv);
    // The header row is ServiceM8's own, byte for byte.
    expect(importRows[0]).toEqual(s8Table.headers);
    expect(outputs[0]!.serviceM8?.matchesCanonicalContract).toBe(true);
    // Every line, including the last, ends CRLF and there is no BOM.
    expect(importCsv.endsWith('\r\n')).toBe(true);
    expect(importCsv.startsWith('\ufeff')).toBe(false);
    expect(importCsv.split('\r\n').length - 1).toBe(importRows.length);

    const identifiers = importRows.slice(1).map((r) => r[0]);
    // Approved: FIC-002, FIC-003, FIC-004, 00123, FIC-010, ALIAS-11
    expect(identifiers).toContain('FIC-002');
    expect(identifiers).toContain('00123'); // leading zero preserved
    expect(identifiers).not.toContain('FIC-012'); // excluded
    expect(identifiers).not.toContain('FIC-001'); // unchanged
    expect(identifiers).not.toContain('FIC-009'); // conflicting duplicate
    expect(identifiers).not.toContain('FIC-007'); // invalid
    expect(identifiers).not.toContain('FIC-013'); // price on application
    expect(identifiers).not.toContain('FIC-900'); // missing is never touched

    const column = (name: string) => s8Table.headers.indexOf(name);
    const rowFor = (id: string) => importRows.find((r) => r[0] === id)!;

    // GST-EXCLUSIVE target row: 48.00 x 1.30 = 62.40, no GST added.
    const fic002 = rowFor('FIC-002');
    expect(fic002[column('Price Includes Taxes')]).toBe('No');
    expect(fic002[column('Price')]).toBe('62.40');
    expect(fic002[column('Purchase Cost')]).toBe('48.00');

    // GST-INCLUSIVE target row: 1.80 x 1.30 = 2.34 ex GST, x 1.10 = 2.57 inc.
    const fic003 = rowFor('FIC-003');
    expect(fic003[column('Price Includes Taxes')]).toBe('Yes');
    expect(fic003[column('Price')]).toBe('2.57');

    // Columns this application does not own survive untouched.
    expect(fic002[column('Quantity In Stock')]).toBe('0');
    expect(fic002[column('Item is Inventoried')]).toBe('No');
    expect(fic002[column('Tax Rate')]).toBe('GST on Income');

    // A new item takes the account's own dominant convention and its barcode.
    const fic004 = rowFor('FIC-004');
    expect(fic004[column('Price Includes Taxes')]).toBe('No');
    expect(fic004[column('Tax Rate')]).toBe('GST on Income');
    expect(fic004[column('Quantity In Stock')]).toBe('0');
    expect(fic004[column('Barcode')]).toBe('9300000000048');
    expect(fic004[column('Price')]).toBe('245.70'); // 189.00 x 1.30

    // A value containing a comma is quoted; the parser round-trips it.
    const fic010 = rowFor('FIC-010');
    expect(fic010[column('Name')]?.startsWith('=HYPERLINK')).toBe(true);
    // Formula-like values are written VERBATIM so ServiceM8 stores them as-is,
    // and reported instead of being silently rewritten.
    expect(importCsv).not.toContain("'=HYPERLINK");
    expect(outputs[0]!.serviceM8?.formulaLikeValues.length).toBeGreaterThan(0);

    // --- exceptions workbook ----------------------------------------------
    const exceptionsWb = await readWorkbook(outputs[2]!.blob);
    expect(exceptionsWb.worksheets.map((w) => w.name)).toEqual([
      'Ambiguous',
      'Invalid',
      'Missing from supplier',
    ]);
    const ambiguous = sheetRows(exceptionsWb.getWorksheet('Ambiguous')!);
    expect(ambiguous.slice(1).some((r) => r[0] === 'FIC-009')).toBe(true);
    const missing = sheetRows(exceptionsWb.getWorksheet('Missing from supplier')!);
    expect(missing.slice(1).some((r) => r[0] === 'FIC-900')).toBe(true);

    // --- rollback CSV ------------------------------------------------------
    const rollbackCsv = await outputs[3]!.blob.text();
    const rollbackRows = parseCsv(rollbackCsv);
    expect(rollbackRows[0]).toEqual(s8Table.headers);
    // Only rows that already existed in ServiceM8 can be rolled back.
    const rollbackIds = rollbackRows.slice(1).map((r) => r[0]);
    expect(rollbackIds).toContain('FIC-002');
    expect(rollbackIds).not.toContain('FIC-004'); // new item has no prior state
    // The prior price is preserved exactly as ServiceM8 exported it.
    expect(rollbackRows.find((r) => r[0] === 'FIC-002')?.[column('Price')]).toBe('58.50');

    // --- change report -----------------------------------------------------
    const changeWb = await readWorkbook(outputs[1]!.blob);
    const allRecords = sheetRows(changeWb.getWorksheet('All records')!);
    expect(allRecords.length).toBe(1 + comparison.rows.length);
    const header = allRecords[0]!;
    const excludedRow = allRecords.find((r) => r[header.indexOf('Supplier code')] === 'FIC-012');
    expect(excludedRow?.[header.indexOf('Decision')]).toBe('Excluded');
    expect(excludedRow?.[header.indexOf('Exclusion reason')]).toBe(
      'Fictional exclusion for testing',
    );

    // --- audit -------------------------------------------------------------
    const auditText = await outputs[4]!.blob.text();
    expect(auditText).toContain('Global markup:       30% on GST-exclusive supplier cost');
    expect(auditText).toContain(
      'Markup precedence: product override > brand blanket > global default',
    );
    expect(auditText).toContain(supplierTable.sha256);
    expect(auditText).toContain('Excluded records (1)');
    expect(auditText).toContain('Fictional exclusion for testing');
    expect(auditText).toContain('Supplier cost basis: Supplier costs exclude GST');
    expect(auditText).toContain('ServiceM8 Materials & Services CSV');
    expect(auditText).toContain(
      'This report was generated locally by SWL Pricing and Inventory Control.',
    );
    expect(auditText).not.toContain('generated locally in the browser');
  });

  it('writes ServiceM8 values verbatim even when they look like formulas', async () => {
    const { supplierTable, s8Table, comparison } = await demoScenario();
    const outputs = await buildAllOutputs({
      comparison,
      decisions: approveRows(
        EMPTY_REVIEW,
        comparison.rows.filter((r) => r.status === 'price-changed' || r.status === 'new-item'),
      ).state.decisions,
      supplierTable,
      s8Table,
      s8Mapping: S8_MAPPING,
      profileName: 'Formula boundary',
      profileVersion: 1,
      taxHandling: 'Supplier costs exclude GST',
      newItemIncludesTaxes: false,
      newItemTaxRate: 'GST on Income',
      settingsChanges: [],
      startedAt: new Date().toISOString(),
      now: new Date(2026, 7, 3),
    });

    const csv = await outputs[0]!.blob.text();
    // The apostrophe neutralisation used for spreadsheets would corrupt a
    // machine import, so it is never applied to the ServiceM8 CSV.
    expect(csv).not.toContain('"\'=');
    expect(csv).not.toContain(",'=");
    expect(outputs[0]!.sanitizedCells).toBe(0);
    // The XLSX reports, which people do open in Excel, still neutralise.
    expect(outputs[1]!.sanitizedCells).toBeGreaterThan(0);
  });
});
