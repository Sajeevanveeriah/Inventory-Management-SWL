/**
 * Defensive parsing limits (documented in docs/FILE-FORMAT-CONTRACT.md).
 * Files beyond these limits are rejected with a specific explanation, which
 * protects against oversized workbooks and zip-decompression abuse.
 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MiB on disk
export const MAX_ROWS = 50_000; // data rows per sheet
export const MAX_COLUMNS = 100; // columns per sheet
export const MAX_SHEETS = 20; // worksheets per workbook
export const MAX_CELL_CHARS = 2_000; // characters kept per cell

export const ACCEPTED_EXTENSIONS = ['.csv', '.xlsx'] as const;

export function describeLimits(): string {
  return `Accepted formats: CSV and XLSX. Limits: ${MAX_FILE_BYTES / 1024 / 1024} MB per file, ${MAX_ROWS.toLocaleString()} rows and ${MAX_COLUMNS} columns per sheet, ${MAX_SHEETS} sheets per workbook.`;
}
