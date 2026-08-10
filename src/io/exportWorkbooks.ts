import ExcelJS from "exceljs";
import type { ComparisonResult, ComparisonRow } from "../core/compare";
import type { DecisionMap } from "../core/review";
import type { ParsedTable } from "../core/table";
import {
  APP_NAME,
  APP_VERSION,
  buildAuditText,
  type AuditInput,
} from "../core/audit";
import { markupFormula } from "../core/money";
import { rowsForImport } from "../core/output";
import { newRunId, outputFilename } from "../core/run";
import { sanitizeForSpreadsheet } from "../core/sanitize";
import { STATUS_LABELS } from "../core/statuses";
import type { ColumnMapping } from "../core/mapping";
import type { SettingsChangeLogEntry } from "../core/settings";

export interface GeneratedOutput {
  filename: string;
  kind: "import" | "change-report" | "exceptions" | "rollback" | "audit";
  label: string;
  blob: Blob;
  /** Count of formula-like values that were neutralised in this output. */
  sanitizedCells: number;
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
  settingsChanges: SettingsChangeLogEntry[];
  startedAt: string;
  now: Date;
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Default candidate headers used when no ServiceM8 template can drive them. */
export const CANDIDATE_IMPORT_HEADERS = [
  "Item Number",
  "Item Description",
  "Cost (AUD)",
  "Sell Price (AUD)",
] as const;

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
    ws.addRow(
      row.map((value) =>
        typeof value === "string" ? writer.text(value) : value,
      ),
    );
  }
  ws.columns.forEach((col, i) => {
    const headerLen = (safeHeaders[i] ?? "").length;
    col.width = Math.min(48, Math.max(12, headerLen + 4));
  });
  return ws;
}

async function toBlob(wb: ExcelJS.Workbook): Promise<Blob> {
  const buffer = await wb.xlsx.writeBuffer();
  return new Blob([buffer], { type: XLSX_MIME });
}

function newWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = `${APP_NAME} v${APP_VERSION}`;
  return wb;
}

function rowIdentifier(row: ComparisonRow): string {
  return row.s8?.itemNumber ?? row.supplier?.code ?? row.id;
}

/** 1. The ServiceM8 candidate import workbook — approved, valid changes only. */
async function buildImportWorkbook(
  input: ExportInput,
  importRows: ComparisonRow[],
): Promise<{ blob: Blob; sanitized: number }> {
  const wb = newWorkbook();
  const writer = new CellWriter();
  const { s8Table, s8Mapping } = input;

  const costCol = s8Mapping.existingCost;
  const sellCol = s8Mapping.existingSellPrice;
  const numberCol = s8Mapping.itemNumber;
  const descCol = s8Mapping.itemDescription;
  const templateAdapted = costCol !== undefined && numberCol !== undefined;

  let headers: string[];
  let dataRows: (string | number)[][];

  if (templateAdapted) {
    // Template adaptation: reuse the loaded ServiceM8 export's header meanings
    // and column order. Formula-like header text is neutralised at the workbook
    // boundary. Price changes re-emit the original row with only the cost/sell
    // columns replaced; new items fill only the mapped columns.
    headers = s8Table.headers;
    dataRows = importRows.map((row) => {
      const out: (string | number)[] = new Array<string | number>(
        headers.length,
      ).fill("");
      if (row.status === "price-changed" && row.s8 !== null) {
        const original = s8Table.rows[row.s8.rowIndex] ?? [];
        for (let c = 0; c < headers.length; c += 1)
          out[c] = writer.text(original[c] ?? "");
      } else {
        if (numberCol !== undefined)
          out[numberCol] = writer.text(row.supplier?.code ?? "");
        if (descCol !== undefined)
          out[descCol] = writer.text(row.supplier?.description ?? "");
      }
      if (costCol !== undefined && row.supplier?.cost != null)
        out[costCol] = writer.amount(row.supplier.cost);
      if (sellCol !== undefined && row.proposedSell !== null)
        out[sellCol] = writer.amount(row.proposedSell);
      return out;
    });
  } else {
    headers = [...CANDIDATE_IMPORT_HEADERS];
    dataRows = importRows.map((row) => [
      writer.text(rowIdentifier(row)),
      writer.text(row.supplier?.description ?? row.s8?.description ?? ""),
      row.supplier?.cost != null ? writer.amount(row.supplier.cost) : "",
      row.proposedSell !== null ? writer.amount(row.proposedSell) : "",
    ]);
  }

  const ws = addTableSheet(wb, "Import", headers, dataRows, writer);
  // Ensure amount columns render with two decimals.
  const amountCols = templateAdapted
    ? [costCol, sellCol].filter((c): c is number => c !== undefined)
    : [2, 3];
  for (const c of amountCols) ws.getColumn(c + 1).numFmt = "0.00";

  addTableSheet(
    wb,
    "Summary",
    ["Field", "Value"],
    [
      ["Generated by", `${APP_NAME} v${APP_VERSION}`],
      [
        "Status",
        "CANDIDATE import file — verify against a genuine ServiceM8 import template before importing",
      ],
      ["Run identifier", ""],
      [
        "Approved price changes",
        importRows.filter((r) => r.status === "price-changed").length,
      ],
      [
        "Approved new items",
        importRows.filter((r) => r.status === "new-item").length,
      ],
      ["Markup applied", `${input.comparison.markupPercent}% on supplier cost`],
      ["Tax handling", input.taxHandling],
      [
        "Headers",
        templateAdapted
          ? "Adapted from the loaded ServiceM8 export"
          : "Built-in candidate header set",
      ],
    ],
    writer,
  );
  return { blob: await toBlob(wb), sanitized: writer.sanitized };
}

/** 2. Detailed change report covering every record and decision. */
async function buildChangeReport(
  input: ExportInput,
): Promise<{ blob: Blob; sanitized: number }> {
  const wb = newWorkbook();
  const writer = new CellWriter();
  const { comparison, decisions } = input;
  const headers = [
    "Status",
    "Decision",
    "Match method",
    "Supplier code",
    "Supplier description",
    "Supplier cost (AUD)",
    "ServiceM8 item number",
    "ServiceM8 description",
    "Existing cost (AUD)",
    "Existing sell (AUD)",
    "Proposed sell (AUD)",
    "Cost movement (AUD)",
    "Pricing formula",
    "Supplier row",
    "ServiceM8 row",
    "Exclusion reason",
    "Messages",
  ];
  const rows = comparison.rows.map((row) => {
    const decision = decisions[row.id];
    return [
      STATUS_LABELS[row.status],
      decision?.state === "approved"
        ? "Approved"
        : decision?.state === "excluded"
          ? "Excluded"
          : "",
      row.matchMethod === "exact-code"
        ? "Exact code"
        : row.matchMethod === "alias"
          ? "Approved alias"
          : "",
      writer.text(row.supplier?.code ?? ""),
      writer.text(row.supplier?.description ?? ""),
      row.supplier?.cost != null ? writer.amount(row.supplier.cost) : "",
      writer.text(row.s8?.itemNumber ?? ""),
      writer.text(row.s8?.description ?? ""),
      row.s8?.existingCost != null ? writer.amount(row.s8.existingCost) : "",
      row.s8?.existingSell != null ? writer.amount(row.s8.existingSell) : "",
      row.proposedSell !== null ? writer.amount(row.proposedSell) : "",
      row.costDelta !== null ? writer.amount(row.costDelta) : "",
      row.supplier?.cost != null && row.proposedSell !== null
        ? writer.text(
            markupFormula(row.supplier.cost, comparison.markupPercent),
          )
        : "",
      row.supplier?.sourceRow ?? "",
      row.s8?.sourceRow ?? "",
      writer.text(decision?.reason ?? ""),
      writer.text(
        row.messages.map((m) => `[${m.severity}] ${m.message}`).join(" | "),
      ),
    ];
  });
  addTableSheet(
    wb,
    "Summary",
    ["Measure", "Count"],
    [
      ["Supplier records", comparison.totals.supplierRecords],
      ["ServiceM8 records", comparison.totals.s8Records],
      ["Exact matches", comparison.totals.exactMatches],
      ["Alias matches", comparison.totals.aliasMatches],
      ["Unchanged", comparison.totals.unchanged],
      ["Price changed", comparison.totals.priceChanged],
      ["New items", comparison.totals.newItems],
      ["Missing from supplier", comparison.totals.missingFromSupplier],
      ["Ambiguous", comparison.totals.ambiguous],
      ["Invalid", comparison.totals.invalid],
      ["Duplicate identifiers", comparison.totals.duplicates],
      ["Blocked from import", comparison.totals.blocked],
    ],
    writer,
  );
  addTableSheet(wb, "All records", headers, rows, writer);
  return { blob: await toBlob(wb), sanitized: writer.sanitized };
}

/** 3. Exceptions workbook: everything the operator must look at separately. */
async function buildExceptionsWorkbook(
  input: ExportInput,
): Promise<{ blob: Blob; sanitized: number }> {
  const wb = newWorkbook();
  const writer = new CellWriter();
  const { comparison } = input;
  const exceptionHeaders = [
    "Identifier",
    "Description",
    "Source row",
    "File",
    "Explanation",
  ];
  const sheetFor = (name: string, rows: ComparisonRow[]) => {
    addTableSheet(
      wb,
      name,
      exceptionHeaders,
      rows.map((row) => [
        writer.text(row.supplier?.code ?? row.s8?.itemNumber ?? ""),
        writer.text(row.supplier?.description ?? row.s8?.description ?? ""),
        row.supplier?.sourceRow ?? row.s8?.sourceRow ?? "",
        row.supplier !== null ? "Supplier" : "ServiceM8",
        writer.text(
          row.messages
            .filter((m) => m.severity !== "info")
            .map((m) => m.message)
            .join(" | ") || row.messages.map((m) => m.message).join(" | "),
        ),
      ]),
      writer,
    );
  };
  sheetFor(
    "Ambiguous",
    comparison.rows.filter((r) => r.status === "ambiguous"),
  );
  sheetFor(
    "Invalid",
    comparison.rows.filter((r) => r.status === "invalid"),
  );
  sheetFor(
    "Missing from supplier",
    comparison.rows.filter((r) => r.status === "missing-from-supplier"),
  );
  return { blob: await toBlob(wb), sanitized: writer.sanitized };
}

/** 4. Rollback copy — source rows preserved except mandatory formula neutralisation. */
async function buildRollbackWorkbook(
  input: ExportInput,
): Promise<{ blob: Blob; sanitized: number }> {
  const wb = newWorkbook();
  const writer = new CellWriter();
  const { s8Table } = input;
  addTableSheet(
    wb,
    "Rollback",
    s8Table.headers,
    s8Table.rows.map((r) => r.map((c) => writer.text(c))),
    writer,
  );
  addTableSheet(
    wb,
    "About",
    ["Field", "Value"],
    [
      [
        "Purpose",
        "Rollback copy of the ServiceM8 export; formula-like text is safely neutralised.",
      ],
      ["Original file", s8Table.fileName],
      ["Original SHA-256", s8Table.sha256],
      ["Sheet", s8Table.selectedSheet],
      ["Rows", s8Table.rows.length],
    ],
    writer,
  );
  return { blob: await toBlob(wb), sanitized: writer.sanitized };
}

/** Build all five outputs. Pure with respect to inputs; downloads are separate. */
export async function buildAllOutputs(
  input: ExportInput,
): Promise<GeneratedOutput[]> {
  const runId = newRunId();
  const importRows = rowsForImport(input.comparison.rows, input.decisions);
  const name = (
    purpose: Parameters<typeof outputFilename>[2],
    ext: "xlsx" | "txt",
  ) => outputFilename(input.now, input.profileName, purpose, runId, ext);

  const importOut = await buildImportWorkbook(input, importRows);
  const changeOut = await buildChangeReport(input);
  const exceptionsOut = await buildExceptionsWorkbook(input);
  const rollbackOut = await buildRollbackWorkbook(input);

  const filenames = [
    name("import-candidate", "xlsx"),
    name("change-report", "xlsx"),
    name("exceptions", "xlsx"),
    name("rollback", "xlsx"),
    name("audit-summary", "txt"),
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
    settingsChanges: input.settingsChanges,
    outputFilenames: [...filenames],
  };
  const auditBlob = new Blob([buildAuditText(auditInput)], {
    type: "text/plain;charset=utf-8",
  });

  return [
    {
      filename: filenames[0],
      kind: "import",
      label: "Candidate ServiceM8 import workbook",
      blob: importOut.blob,
      sanitizedCells: importOut.sanitized,
    },
    {
      filename: filenames[1],
      kind: "change-report",
      label: "Detailed change report",
      blob: changeOut.blob,
      sanitizedCells: changeOut.sanitized,
    },
    {
      filename: filenames[2],
      kind: "exceptions",
      label: "Exceptions workbook",
      blob: exceptionsOut.blob,
      sanitizedCells: exceptionsOut.sanitized,
    },
    {
      filename: filenames[3],
      kind: "rollback",
      label: "Rollback copy of the ServiceM8 export",
      blob: rollbackOut.blob,
      sanitizedCells: rollbackOut.sanitized,
    },
    {
      filename: filenames[4],
      kind: "audit",
      label: "Audit summary (plain text)",
      blob: auditBlob,
      sanitizedCells: 0,
    },
  ];
}
