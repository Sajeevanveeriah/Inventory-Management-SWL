/** A parsed tabular file, held in memory only. All cell values are strings. */
export interface ParsedTable {
  fileName: string;
  fileType: 'csv' | 'xlsx';
  byteSize: number;
  /** SHA-256 of the raw file bytes, computed locally for the audit report. */
  sha256: string;
  /** All sheet names in the workbook; a CSV has a single pseudo-sheet. */
  sheetNames: string[];
  selectedSheet: string;
  headers: string[];
  /** Data rows (excluding the header row). Cell text is preserved verbatim. */
  rows: string[][];
  /** Non-blocking parser warnings (e.g. formula cells converted to results). */
  warnings: string[];
}

export type FileRole = 'supplier' | 'servicem8';

/** 1-based spreadsheet row number for a data row index (header is row 1). */
export function sourceRowNumber(dataRowIndex: number): number {
  return dataRowIndex + 2;
}
