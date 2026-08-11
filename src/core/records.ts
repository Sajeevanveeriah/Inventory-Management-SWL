import type { ColumnMapping } from "./mapping";
import type { ParsedTable } from "./table";
import { sourceRowNumber } from "./table";
import { normalizeIdentifier } from "./normalize";
import { parseMoney } from "./money";
import { isFormulaLike } from "./sanitize";
import { isScientificNotation, parseIncludesTaxes } from "./servicem8Format";

export interface RowIssue {
  severity: "error" | "warning";
  field: string;
  message: string;
}

/**
 * Supplier price lists mark items they will not publish a price for. These are
 * not malformed data — they are a deliberate "ask us" marker — so they get
 * their own explanation instead of a generic parse failure.
 */
const PRICE_ON_APPLICATION =
  /^(p\.?\s*o\.?\s*a\.?|price\s+on\s+application|poa)$/i;

export function isPriceOnApplication(raw: string): boolean {
  return PRICE_ON_APPLICATION.test(raw.trim());
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
  barcode: string;
  /** Supplier catalogue grouping, retained for future range expansion. */
  category?: string;
  /** True when the supplier declined to publish a price for this item. */
  priceOnApplication: boolean;
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
  /** Whether this row's Price is GST-inclusive, per its own column. */
  includesTaxes: boolean;
  includesTaxesRaw: string;
  taxRateRaw: string;
  quantityInStockRaw: string;
  itemIsInventoriedRaw: string;
  barcodeRaw: string;
  issues: RowIssue[];
}

function cell(row: string[], col: number | undefined): string {
  if (col === undefined) return "";
  return row[col] ?? "";
}

function flagFormulaLike(
  issues: RowIssue[],
  field: string,
  value: string,
): void {
  if (isFormulaLike(value)) {
    issues.push({
      severity: "warning",
      field,
      message: `Value begins with a formula character and will be neutralised in any generated spreadsheet: “${value.slice(0, 30)}”`,
    });
  }
}

function flagScientificNotation(
  issues: RowIssue[],
  field: string,
  value: string,
): void {
  if (isScientificNotation(value)) {
    issues.push({
      severity: "warning",
      field,
      message: `“${value.trim()}” is scientific notation, not an identifier. A spreadsheet has damaged this value while the file was opened and re-saved, and the original digits cannot be recovered. Re-export the file without opening it in Excel, or format the column as text before saving.`,
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
    const barcode = cell(row, mapping.supplierBarcode).trim();
    const category = cell(row, mapping.supplierCategory).trim();

    if (code === "") {
      issues.push({
        severity: "error",
        field: "Supplier item code",
        message: "Supplier item code is missing.",
      });
    }

    const priceOnApplication = isPriceOnApplication(costRaw);
    let cost: string | null = null;
    if (priceOnApplication) {
      issues.push({
        severity: "error",
        field: "Supplier cost",
        message:
          "The supplier lists this item as price on application, so there is no cost to mark up. Obtain a quoted cost and price this item by hand.",
      });
    } else {
      const parsed = parseMoney(costRaw);
      if (parsed.ok) {
        cost = parsed.amount;
        if (parsed.wasRounded) {
          issues.push({
            severity: "warning",
            field: "Supplier cost",
            message: `Cost “${costRaw}” has more than 2 decimal places and was rounded half-up to ${parsed.amount}.`,
          });
        }
      } else {
        issues.push({
          severity: "error",
          field: "Supplier cost",
          message: `Supplier cost is invalid: ${parsed.error}.`,
        });
      }
    }

    flagFormulaLike(issues, "Supplier item code", code);
    flagFormulaLike(issues, "Supplier description", description);
    flagScientificNotation(issues, "Supplier item code", code);
    if (barcode !== "")
      flagScientificNotation(issues, "Supplier barcode", barcode);

    return {
      rowIndex,
      sourceRow: sourceRowNumber(rowIndex),
      code,
      codeNorm: normalizeIdentifier(code),
      description,
      costRaw,
      cost,
      barcode,
      category,
      priceOnApplication,
      issues,
    };
  });
}

export function extractS8Records(
  table: ParsedTable,
  mapping: ColumnMapping,
): S8Record[] {
  return table.rows.map((row, rowIndex) => {
    const issues: RowIssue[] = [];
    const itemNumber = cell(row, mapping.itemNumber).trim();
    const description = cell(row, mapping.itemDescription).trim();
    const existingCostRaw = cell(row, mapping.existingCost).trim();
    const existingSellRaw = cell(row, mapping.existingSellPrice).trim();
    const includesTaxesRaw = cell(row, mapping.priceIncludesTaxes).trim();
    const taxRateRaw = cell(row, mapping.taxRate);
    const quantityInStockRaw = cell(row, mapping.quantityInStock);
    const itemIsInventoriedRaw = cell(row, mapping.itemIsInventoried);
    const barcodeRaw = cell(row, mapping.barcode);

    if (itemNumber === "") {
      issues.push({
        severity: "error",
        field: "Item Number",
        message: "ServiceM8 item number is missing.",
      });
    }

    // Purchase Cost is routinely zero or absent in genuine ServiceM8 exports,
    // so it is informational only and never blocks a row.
    let existingCost: string | null = null;
    if (existingCostRaw !== "") {
      const costParsed = parseMoney(existingCostRaw);
      if (costParsed.ok) {
        existingCost = costParsed.amount;
      } else {
        issues.push({
          severity: "warning",
          field: "Purchase Cost",
          message: `Existing purchase cost could not be read (${costParsed.error}) and is shown as blank.`,
        });
      }
    }

    // Price is the value this application compares against and replaces, so an
    // unreadable Price blocks the row.
    let existingSell: string | null = null;
    if (existingSellRaw === "") {
      issues.push({
        severity: "error",
        field: "Price",
        message:
          "The ServiceM8 price is missing, so there is nothing to compare against.",
      });
    } else {
      const sellParsed = parseMoney(existingSellRaw);
      if (sellParsed.ok) {
        existingSell = sellParsed.amount;
      } else {
        issues.push({
          severity: "error",
          field: "Price",
          message: `The ServiceM8 price is invalid: ${sellParsed.error}.`,
        });
      }
    }

    // The tax basis decides whether GST is added to the marked-up cost. An
    // unrecognised value is an error rather than a default, because defaulting
    // it moves the price by the whole GST rate.
    const taxFlag = parseIncludesTaxes(includesTaxesRaw);
    if (mapping.priceIncludesTaxes !== undefined && !taxFlag.recognised) {
      issues.push({
        severity: "error",
        field: "Price Includes Taxes",
        message:
          includesTaxesRaw === ""
            ? "The tax basis for this row is blank, so it cannot be determined whether the price includes GST."
            : `“${includesTaxesRaw}” is not a recognised tax basis. Expected “Yes” or “No”.`,
      });
    }

    flagFormulaLike(issues, "Item Number", itemNumber);
    flagFormulaLike(issues, "Name", description);
    flagScientificNotation(issues, "Item Number", itemNumber);
    if (barcodeRaw.trim() !== "")
      flagScientificNotation(issues, "Barcode", barcodeRaw);

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
      includesTaxes: taxFlag.includesTaxes,
      includesTaxesRaw,
      taxRateRaw,
      quantityInStockRaw,
      itemIsInventoriedRaw,
      barcodeRaw,
      issues,
    };
  });
}
