import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import type { ParsedTable } from '../core/table';
import { sha256Hex } from './hash';
import {
  ACCEPTED_EXTENSIONS,
  MAX_CELL_CHARS,
  MAX_COLUMNS,
  MAX_FILE_BYTES,
  MAX_ROWS,
  MAX_SHEETS,
} from './limits';

export class ParseError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.name = 'ParseError';
    this.detail = detail;
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Parse a supplier or ServiceM8 export. All values become strings; leading
 * zeroes and punctuation in text cells are preserved verbatim. The file is
 * held in memory only.
 */
export async function parseFile(file: File, preferredSheet?: string): Promise<ParsedTable> {
  const ext = extensionOf(file.name);
  if (!ACCEPTED_EXTENSIONS.includes(ext as (typeof ACCEPTED_EXTENSIONS)[number])) {
    throw new ParseError(
      `“${file.name}” is not a supported file type.`,
      `Only ${ACCEPTED_EXTENSIONS.join(' and ')} files are accepted. Legacy .xls workbooks should be re-saved as .xlsx first.`,
    );
  }
  if (file.size === 0) {
    throw new ParseError(`“${file.name}” is empty.`, 'The file contains no data at all.');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new ParseError(
      `“${file.name}” is too large (${(file.size / 1024 / 1024).toFixed(1)} MB).`,
      `The limit is ${MAX_FILE_BYTES / 1024 / 1024} MB per file. Split the export or remove unused sheets.`,
    );
  }
  const buffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);

  if (ext === '.csv') {
    return parseCsv(file.name, buffer, file.size, sha256);
  }
  return parseXlsx(file.name, buffer, file.size, sha256, preferredSheet);
}

function truncateCell(value: string, warnings: string[], where: string): string {
  if (value.length > MAX_CELL_CHARS) {
    warnings.push(`${where}: a cell longer than ${MAX_CELL_CHARS} characters was truncated.`);
    return value.slice(0, MAX_CELL_CHARS);
  }
  return value;
}

function finalizeRows(
  fileName: string,
  rawRows: string[][],
  warnings: string[],
): { headers: string[]; rows: string[][] } {
  const nonEmpty = rawRows.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) {
    throw new ParseError(`“${fileName}” contains no data rows.`, 'The sheet is empty.');
  }
  const headers = (nonEmpty[0] as string[]).map((h) => h.trim());
  if (headers.every((h) => h === '')) {
    throw new ParseError(
      `“${fileName}” has an empty header row.`,
      'The first row must contain column headings so columns can be mapped.',
    );
  }
  if (headers.length > MAX_COLUMNS) {
    throw new ParseError(
      `“${fileName}” has too many columns (${headers.length}).`,
      `The limit is ${MAX_COLUMNS} columns per sheet.`,
    );
  }
  const rows = nonEmpty.slice(1);
  if (rows.length === 0) {
    throw new ParseError(
      `“${fileName}” has headers but no data rows.`,
      'At least one data row is required below the header row.',
    );
  }
  if (rows.length > MAX_ROWS) {
    throw new ParseError(
      `“${fileName}” has too many rows (${rows.length.toLocaleString()}).`,
      `The limit is ${MAX_ROWS.toLocaleString()} data rows per sheet.`,
    );
  }
  // Pad/trim every row to header width so cell lookups stay in range.
  const width = headers.length;
  const shaped = rows.map((r) => {
    const out = r.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
  if (rows.some((r) => r.length > width)) {
    warnings.push('Some rows had more cells than the header row; the extras were ignored.');
  }
  return { headers, rows: shaped };
}

function parseCsv(
  fileName: string,
  buffer: ArrayBuffer,
  byteSize: number,
  sha256: string,
): ParsedTable {
  const text = new TextDecoder('utf-8').decode(buffer);
  const warnings: string[] = [];
  const result = Papa.parse<string[]>(text, {
    dynamicTyping: false, // keep everything as strings — preserves leading zeroes
    skipEmptyLines: 'greedy',
  });
  for (const err of result.errors.slice(0, 3)) {
    warnings.push(`CSV row ${err.row === undefined ? '?' : err.row + 1}: ${err.message}`);
  }
  const raw = result.data.map((r, i) =>
    r.map((c) => truncateCell(String(c ?? ''), warnings, `Row ${i + 1}`)),
  );
  const { headers, rows } = finalizeRows(fileName, raw, warnings);
  return {
    fileName,
    fileType: 'csv',
    byteSize,
    sha256,
    sheetNames: ['CSV data'],
    selectedSheet: 'CSV data',
    headers,
    rows,
    warnings,
  };
}

/** Convert an ExcelJS cell to plain text without evaluating anything. */
function cellText(cell: ExcelJS.Cell, warnings: string[], sheet: string): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) {
      const noted = warnings.some((w) => w.includes('formula cells'));
      if (!noted) {
        warnings.push(
          `Sheet “${sheet}”: contains formula cells. Their last calculated values were used; formulas themselves are never executed.`,
        );
      }
      const result = (value as ExcelJS.CellFormulaValue).result;
      if (result === null || result === undefined) return '';
      if (typeof result === 'object' && 'error' in result) return '';
      return String(result instanceof Date ? result.toISOString() : result);
    }
    if ('richText' in value) {
      return (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
    }
    if ('text' in value) {
      return String((value as ExcelJS.CellHyperlinkValue).text ?? '');
    }
    if ('error' in value) return '';
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return '';
  }
  return String(value);
}

async function parseXlsx(
  fileName: string,
  buffer: ArrayBuffer,
  byteSize: number,
  sha256: string,
  preferredSheet?: string,
): Promise<ParsedTable> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new ParseError(
      `“${fileName}” could not be read as an XLSX workbook.`,
      'The file may be corrupted, password-protected, or not a real XLSX file. Re-export it and try again.',
    );
  }
  const sheets = workbook.worksheets.filter((ws) => ws.state !== 'veryHidden');
  if (sheets.length === 0) {
    throw new ParseError(`“${fileName}” contains no worksheets.`, 'The workbook is empty.');
  }
  if (sheets.length > MAX_SHEETS) {
    throw new ParseError(
      `“${fileName}” has too many sheets (${sheets.length}).`,
      `The limit is ${MAX_SHEETS} sheets per workbook.`,
    );
  }
  const sheetNames = sheets.map((ws) => ws.name);
  const chosenName =
    preferredSheet !== undefined && sheetNames.includes(preferredSheet)
      ? preferredSheet
      : (sheetNames[0] as string);
  const ws = sheets.find((s) => s.name === chosenName) as ExcelJS.Worksheet;

  if (ws.rowCount > MAX_ROWS + 1) {
    throw new ParseError(
      `Sheet “${chosenName}” in “${fileName}” has too many rows (${ws.rowCount.toLocaleString()}).`,
      `The limit is ${MAX_ROWS.toLocaleString()} data rows per sheet.`,
    );
  }
  const warnings: string[] = [];
  const raw: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    const width = Math.min(row.cellCount, MAX_COLUMNS + 1);
    for (let c = 1; c <= width; c += 1) {
      cells.push(
        truncateCell(
          cellText(row.getCell(c), warnings, chosenName),
          warnings,
          `Sheet ${chosenName}`,
        ),
      );
    }
    raw.push(cells);
  });
  const { headers, rows } = finalizeRows(fileName, raw, warnings);
  return {
    fileName,
    fileType: 'xlsx',
    byteSize,
    sha256,
    sheetNames,
    selectedSheet: chosenName,
    headers,
    rows,
    warnings,
  };
}
