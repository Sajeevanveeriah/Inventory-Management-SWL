import type ExcelJS from 'exceljs';
import type { ComparisonResult, ComparisonRow } from '../core/compare';
import type { DecisionMap } from '../core/review';
import type { ParsedTable } from '../core/table';
import { APP_NAME, APP_VERSION, buildAuditText, type AuditInput } from '../core/audit';
import { rowsForImport } from '../core/output';
import { newRunId, outputFilename } from '../core/run';
import { sanitizeForSpreadsheet } from '../core/sanitize';
import { STATUS_LABELS } from '../core/statuses';
import { PRICE_BASIS_LABELS } from '../core/pricing';
import { SERVICEM8_CSV_MIME } from '../core/servicem8Format';
import {
  buildServiceM8Import,
  buildServiceM8Rollback,
  type ServiceM8ImportBuild,
} from './servicem8Import';
import type { ColumnMapping } from '../core/mapping';
import type { SettingsChangeLogEntry } from '../core/settings';

export interface GeneratedOutput {
  filename: string;
  kind: 'import' | 'change-report' | 'exceptions' | 'rollback' | 'audit';
  label: string;
  blob: Blob;
  /** Count of formula-like values that were neutralised in this output. */
  sanitizedCells: number;
  /** Set on the ServiceM8 CSV outputs; drives the format assurances shown. */
  serviceM8?: ServiceM8ImportBuild;
}

export interface ExportInput {
  comparison: ComparisonResult;
  decisions: DecisionMap;
  supplierTable: ParsedTable;
  s8Table: ParsedTable;
  s8Mapping: ColumnMapping;
  profileName: string;
  profileVersion: number;
  taxHandling: string;
  /** Tax basis applied to items created by this run. */
  newItemIncludesTaxes: boolean;
  /** Tax rate label applied to items created by this run. */
  newItemTaxRate: string;
  settingsChanges: SettingsChangeLogEntry[];
  startedAt: string;
  now: Date;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class CellWriter {
  sanitized = 0;
  text(value: string): string {
    const { value: safe, flagged } = sanitizeForSpreadsheet(value);
    if (flagged) this.sanitized += 1;
    return safe;
  }
  /** Canonical 2-decimal amount written as a real number with a 0.00 format. */
  amount(value: string): number {
    return Number(value);
  }
}

function addTableSheet(
  wb: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: (string | number)[][],
  writer: CellWriter,
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name);
  const safeHeaders = headers.map((header) => writer.text(header));
  ws.addRow(safeHeaders);
  ws.getRow(1).font = { bold: true };
  for (const row of rows) {
    ws.addRow(row.map((value) => (typeof value === 'string' ? writer.text(value) : value)));
  }
  ws.columns.forEach((col, i) => {
    const headerLen = (safeHeaders[i] ?? '').length;
    col.width = Math.min(48, Math.max(12, headerLen + 4));
  });
  return ws;
}

async function toBlob(wb: ExcelJS.Workbook): Promise<Blob> {
  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], { type: XLSX_MIME });
}

async function newWorkbook(): Promise<ExcelJS.Workbook> {
  const { default: ExcelJSRuntime } = await import('exceljs');
  const wb = new ExcelJSRuntime.Workbook();
  wb.creator = `${APP_NAME} v${APP_VERSION}`;
  return wb;
}

/** 2. Detailed change report covering every record and decision. */
async function buildChangeReport(input: ExportInput): Promise<{ blob: Blob; sanitized: number }> {
  const wb = await newWorkbook();
  const writer = new CellWriter();
  const { comparison, decisions } = input;
  const headers = [
    'Status',
    'Decision',
    'Match method',
    'Supplier code',
    'Supplier description',
    'Supplier cost (AUD)',
    'Supplier cost ex GST (AUD)',
    'ServiceM8 item number',
    'ServiceM8 description',
    'ServiceM8 price basis',
    'Existing purchase cost (AUD)',
    'Existing price (AUD)',
    'Proposed price (AUD)',
    'Price movement (AUD)',
    'Cost movement (AUD)',
    'Pricing derivation',
    'Duplicate supplier rows folded in',
    'Supplier row',
    'ServiceM8 row',
    'Exclusion reason',
    'Messages',
  ];
  const rows = comparison.rows.map((row) => {
    const decision = decisions[row.id];
    return [
      STATUS_LABELS[row.status],
      decision?.state === 'approved'
        ? 'Approved'
        : decision?.state === 'excluded'
          ? 'Excluded'
          : '',
      row.matchMethod === 'exact-code'
        ? 'Exact code'
        : row.matchMethod === 'alias'
          ? 'Approved alias'
          : '',
      writer.text(row.supplier?.code ?? ''),
      writer.text(row.supplier?.description ?? ''),
      row.supplier?.cost != null ? writer.amount(row.supplier.cost) : '',
      row.pricing !== null ? writer.amount(row.pricing.costExGst) : '',
      writer.text(row.s8?.itemNumber ?? ''),
      writer.text(row.s8?.description ?? ''),
      row.targetBasis !== null ? writer.text(PRICE_BASIS_LABELS[row.targetBasis]) : '',
      row.s8?.existingCost != null ? writer.amount(row.s8.existingCost) : '',
      row.s8?.existingSell != null ? writer.amount(row.s8.existingSell) : '',
      row.proposedSell !== null ? writer.amount(row.proposedSell) : '',
      row.priceDelta !== null ? writer.amount(row.priceDelta) : '',
      row.costDelta !== null ? writer.amount(row.costDelta) : '',
      writer.text(row.pricing?.explanation ?? ''),
      row.duplicateSourceRows.length > 0 ? writer.text(row.duplicateSourceRows.join(', ')) : '',
      row.supplier?.sourceRow ?? '',
      row.s8?.sourceRow ?? '',
      writer.text(decision?.reason ?? ''),
      writer.text(row.messages.map((m) => `[${m.severity}] ${m.message}`).join(' | ')),
    ];
  });
  addTableSheet(
    wb,
    'Summary',
    ['Measure', 'Count'],
    [
      ['Supplier records', comparison.totals.supplierRecords],
      ['ServiceM8 records', comparison.totals.s8Records],
      ['Exact matches', comparison.totals.exactMatches],
      ['Alias matches', comparison.totals.aliasMatches],
      ['Unchanged', comparison.totals.unchanged],
      ['Price changed', comparison.totals.priceChanged],
      ['New items', comparison.totals.newItems],
      ['Missing from supplier', comparison.totals.missingFromSupplier],
      ['Ambiguous', comparison.totals.ambiguous],
      ['Invalid', comparison.totals.invalid],
      ['Duplicate identifiers', comparison.totals.duplicates],
      ['Duplicate supplier rows folded in', comparison.totals.duplicatesCollapsed],
      ['Blocked from import', comparison.totals.blocked],
    ],
    writer,
  );
  addTableSheet(wb, 'All records', headers, rows, writer);
  return { blob: await toBlob(wb), sanitized: writer.sanitized };
}

/** 3. Exceptions workbook: everything the operator must look at separately. */
async function buildExceptionsWorkbook(
  input: ExportInput,
): Promise<{ blob: Blob; sanitized: number }> {
  const wb = await newWorkbook();
  const writer = new CellWriter();
  const { comparison } = input;
  const exceptionHeaders = ['Identifier', 'Description', 'Source row', 'File', 'Explanation'];
  const sheetFor = (name: string, rows: ComparisonRow[]) => {
    addTableSheet(
      wb,
      name,
      exceptionHeaders,
      rows.map((row) => [
        writer.text(row.supplier?.code ?? row.s8?.itemNumber ?? ''),
        writer.text(row.supplier?.description ?? row.s8?.description ?? ''),
        row.supplier?.sourceRow ?? row.s8?.sourceRow ?? '',
        row.supplier !== null ? 'Supplier' : 'ServiceM8',
        writer.text(
          row.messages
            .filter((m) => m.severity !== 'info')
            .map((m) => m.message)
            .join(' | ') || row.messages.map((m) => m.message).join(' | '),
        ),
      ]),
      writer,
    );
  };
  sheetFor(
    'Ambiguous',
    comparison.rows.filter((r) => r.status === 'ambiguous'),
  );
  sheetFor(
    'Invalid',
    comparison.rows.filter((r) => r.status === 'invalid'),
  );
  sheetFor(
    'Missing from supplier',
    comparison.rows.filter((r) => r.status === 'missing-from-supplier'),
  );
  return { blob: await toBlob(wb), sanitized: writer.sanitized };
}

/** Build every run output. Pure with respect to inputs; downloads are separate. */
export async function buildAllOutputs(input: ExportInput): Promise<GeneratedOutput[]> {
  const runId = newRunId();
  const importRows = rowsForImport(input.comparison.rows, input.decisions);
  const name = (purpose: Parameters<typeof outputFilename>[2], ext: 'xlsx' | 'txt' | 'csv') =>
    outputFilename(input.now, input.profileName, purpose, runId, ext);

  const serviceM8Input = {
    rows: importRows,
    s8Table: input.s8Table,
    s8Mapping: input.s8Mapping,
    newItemIncludesTaxes: input.newItemIncludesTaxes,
    newItemTaxRate: input.newItemTaxRate,
  };
  const importBuild = buildServiceM8Import(serviceM8Input);
  const rollbackBuild = buildServiceM8Rollback(serviceM8Input);
  const changeOut = await buildChangeReport(input);
  const exceptionsOut = await buildExceptionsWorkbook(input);

  const filenames = [
    name('servicem8-import', 'csv'),
    name('change-report', 'xlsx'),
    name('exceptions', 'xlsx'),
    name('servicem8-rollback', 'csv'),
    name('audit-summary', 'txt'),
  ] as const;

  const auditInput: AuditInput = {
    runId,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    supplierTable: input.supplierTable,
    s8Table: input.s8Table,
    profileName: input.profileName,
    profileVersion: input.profileVersion,
    comparison: input.comparison,
    decisions: input.decisions,
    taxHandling: input.taxHandling,
    newItemConvention: `${input.newItemIncludesTaxes ? 'Price includes GST' : 'Price excludes GST'}, tax rate “${input.newItemTaxRate}”`,
    importFormat: importBuild.matchesCanonicalContract
      ? 'ServiceM8 Materials & Services CSV - canonical column contract'
      : `ServiceM8 CSV adapted from the loaded export (${importBuild.headers.length} columns)`,
    settingsChanges: input.settingsChanges,
    outputFilenames: [...filenames],
  };
  const auditBlob = new Blob([buildAuditText(auditInput)], {
    type: 'text/plain;charset=utf-8',
  });

  const csvBlob = (text: string) => new Blob([text], { type: SERVICEM8_CSV_MIME });

  return [
    {
      filename: filenames[0],
      kind: 'import',
      label: 'ServiceM8 import file (CSV)',
      blob: csvBlob(importBuild.text),
      sanitizedCells: 0,
      serviceM8: importBuild,
    },
    {
      filename: filenames[1],
      kind: 'change-report',
      label: 'Detailed change report',
      blob: changeOut.blob,
      sanitizedCells: changeOut.sanitized,
    },
    {
      filename: filenames[2],
      kind: 'exceptions',
      label: 'Exceptions workbook',
      blob: exceptionsOut.blob,
      sanitizedCells: exceptionsOut.sanitized,
    },
    {
      filename: filenames[3],
      kind: 'rollback',
      label: 'ServiceM8 rollback file (CSV) - prior values of the changed rows',
      blob: csvBlob(rollbackBuild.text),
      sanitizedCells: 0,
      serviceM8: rollbackBuild,
    },
    {
      filename: filenames[4],
      kind: 'audit',
      label: 'Audit summary (plain text)',
      blob: auditBlob,
      sanitizedCells: 0,
    },
  ];
}
