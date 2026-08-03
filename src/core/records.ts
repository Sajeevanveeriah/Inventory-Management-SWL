import type { ColumnMapping } from './mapping';
import type { ParsedTable } from './table';
import { sourceRowNumber } from './table';
import { normalizeIdentifier } from './normalize';
import { parseMoney } from './money';
import { isFormulaLike } from './sanitize';

export interface RowIssue {
  severity: 'error' | 'warning';
  field: string;
  message: string;
}

export interface SupplierRecord {
  rowIndex: number;
  sourceRow: number;
  code: string;
  codeNorm: string;
  description: string;
  costRaw: string;
  /** Canonical 2-decimal amount, present only when the cost parsed cleanly. */
  cost: string | null;
  issues: RowIssue[];
}

export interface S8Record {
  rowIndex: number;
  sourceRow: number;
  itemNumber: string;
  itemNumberNorm: string;
  description: string;
  existingCostRaw: string;
  existingCost: string | null;
  existingSellRaw: string;
  existingSell: string | null;
  issues: RowIssue[];
}

function cell(row: string[], col: number | undefined): string {
  if (col === undefined) return '';
  return row[col] ?? '';
}

function flagFormulaLike(issues: RowIssue[], field: string, value: string): void {
  if (isFormulaLike(value)) {
    issues.push({
      severity: 'warning',
      field,
      message: `Value begins with a formula character and will be neutralised in any generated spreadsheet: “${value.slice(0, 30)}”`,
    });
  }
}

export function extractSupplierRecords(
  table: ParsedTable,
  mapping: ColumnMapping,
): SupplierRecord[] {
  return table.rows.map((row, rowIndex) => {
    const issues: RowIssue[] = [];
    const code = cell(row, mapping.supplierCode).trim();
    const description = cell(row, mapping.supplierDescription).trim();
    const costRaw = cell(row, mapping.supplierCost).trim();

    if (code === '') {
      issues.push({
        severity: 'error',
        field: 'Supplier item code',
        message: 'Supplier item code is missing.',
      });
    }
    let cost: string | null = null;
    const parsed = parseMoney(costRaw);
    if (parsed.ok) {
      cost = parsed.amount;
      if (parsed.wasRounded) {
        issues.push({
          severity: 'warning',
          field: 'Supplier cost',
          message: `Cost “${costRaw}” has more than 2 decimal places and was rounded half-up to ${parsed.amount}.`,
        });
      }
    } else {
      issues.push({
        severity: 'error',
        field: 'Supplier cost',
        message: `Supplier cost is invalid: ${parsed.error}.`,
      });
    }
    flagFormulaLike(issues, 'Supplier item code', code);
    flagFormulaLike(issues, 'Supplier description', description);

    return {
      rowIndex,
      sourceRow: sourceRowNumber(rowIndex),
      code,
      codeNorm: normalizeIdentifier(code),
      description,
      costRaw,
      cost,
      issues,
    };
  });
}

export function extractS8Records(table: ParsedTable, mapping: ColumnMapping): S8Record[] {
  return table.rows.map((row, rowIndex) => {
    const issues: RowIssue[] = [];
    const itemNumber = cell(row, mapping.itemNumber).trim();
    const description = cell(row, mapping.itemDescription).trim();
    const existingCostRaw = cell(row, mapping.existingCost).trim();
    const existingSellRaw = cell(row, mapping.existingSellPrice).trim();

    if (itemNumber === '') {
      issues.push({
        severity: 'error',
        field: 'ServiceM8 item number',
        message: 'ServiceM8 item number is missing.',
      });
    }
    let existingCost: string | null = null;
    const costParsed = parseMoney(existingCostRaw);
    if (costParsed.ok) {
      existingCost = costParsed.amount;
    } else {
      issues.push({
        severity: 'error',
        field: 'Existing cost',
        message: `Existing cost is invalid: ${costParsed.error}.`,
      });
    }
    let existingSell: string | null = null;
    if (mapping.existingSellPrice !== undefined && existingSellRaw !== '') {
      const sellParsed = parseMoney(existingSellRaw);
      if (sellParsed.ok) {
        existingSell = sellParsed.amount;
      } else {
        issues.push({
          severity: 'warning',
          field: 'Existing selling price',
          message: `Existing selling price could not be read (${sellParsed.error}) and is shown as blank.`,
        });
      }
    }
    flagFormulaLike(issues, 'ServiceM8 item number', itemNumber);
    flagFormulaLike(issues, 'ServiceM8 description', description);

    return {
      rowIndex,
      sourceRow: sourceRowNumber(rowIndex),
      itemNumber,
      itemNumberNorm: normalizeIdentifier(itemNumber),
      description,
      existingCostRaw,
      existingCost,
      existingSellRaw,
      existingSell,
      issues,
    };
  });
}
