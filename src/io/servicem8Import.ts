import type { ComparisonRow } from '../core/compare';
import type { ColumnMapping } from '../core/mapping';
import type { ParsedTable } from '../core/table';
import { isFormulaLike } from '../core/sanitize';
import {
  GST_ON_INCOME,
  NO,
  SERVICEM8_COLUMNS,
  encodeServiceM8Csv,
  formatIncludesTaxes,
  formatServiceM8Amount,
  isScientificNotation,
  matchServiceM8Layout,
  type ServiceM8Column,
} from '../core/servicem8Format';

/**
 * Generation of the file ServiceM8 imports.
 *
 * The output is a ServiceM8 Materials & Services CSV, produced so that it is
 * structurally indistinguishable from a genuine ServiceM8 export: same header
 * row, same column order, same value conventions, same CSV dialect.
 *
 * Rows are built by copying the ORIGINAL ServiceM8 row verbatim and replacing
 * only the two money columns this application is responsible for. Every other
 * column - tax basis, stock quantity, inventory flag, barcode, and any column
 * this application does not model - survives the round trip untouched. New
 * items fill the columns the mapping resolves and take documented defaults for
 * the rest.
 *
 * FORMULA NEUTRALISATION IS DELIBERATELY NOT APPLIED HERE. Prefixing a value
 * with an apostrophe is a spreadsheet display convention; ServiceM8's importer
 * would store the apostrophe as part of the value and corrupt the record. The
 * generated CSV is a machine handoff, so values are written verbatim and any
 * formula-like value is reported to the operator instead. The XLSX reports,
 * which people do open in a spreadsheet, keep full neutralisation.
 */

export interface ServiceM8ImportBuild {
  /** The complete CSV document text. */
  text: string;
  /** The header row actually written. */
  headers: string[];
  /** Number of data rows written. */
  rowCount: number;
  /** True when the header row equals the canonical ServiceM8 contract. */
  matchesCanonicalContract: boolean;
  /** Columns of the contract the loaded ServiceM8 file did not provide. */
  missingColumns: ServiceM8Column[];
  /** Values written verbatim that a spreadsheet would read as a formula. */
  formulaLikeValues: string[];
  /** Identifiers damaged into scientific notation by a spreadsheet. */
  damagedIdentifiers: string[];
  /** Defaults applied to new items, for disclosure in the UI and audit. */
  newItemDefaults: { column: ServiceM8Column; value: string }[];
}

export interface ServiceM8ImportInput {
  rows: ComparisonRow[];
  s8Table: ParsedTable;
  s8Mapping: ColumnMapping;
  /** Tax basis assigned to items that do not yet exist in ServiceM8. */
  newItemIncludesTaxes: boolean;
  /** Tax rate label assigned to items that do not yet exist in ServiceM8. */
  newItemTaxRate: string;
}

/** Defaults for the columns a brand-new item has no source value for. */
const NEW_ITEM_QUANTITY_IN_STOCK = '0';
const NEW_ITEM_IS_INVENTORIED = NO;

/**
 * Map a canonical ServiceM8 column to the output column index, preferring the
 * loaded file's own layout so extra columns are preserved in place.
 */
function resolveColumns(
  headers: string[],
  mapping: ColumnMapping,
): Record<ServiceM8Column, number | null> {
  const layout = matchServiceM8Layout(headers);
  const resolved = { ...layout.indexes };
  // The operator's confirmed mapping wins wherever it is set: it is an
  // explicit statement about this file that beats header-name inference.
  const fromMapping: [ServiceM8Column, number | undefined][] = [
    ['Item Number', mapping.itemNumber],
    ['Name', mapping.itemDescription],
    ['Purchase Cost', mapping.existingCost],
    ['Price', mapping.existingSellPrice],
    ['Price Includes Taxes', mapping.priceIncludesTaxes],
    ['Tax Rate', mapping.taxRate],
    ['Quantity In Stock', mapping.quantityInStock],
    ['Item is Inventoried', mapping.itemIsInventoried],
    ['Barcode', mapping.barcode],
  ];
  for (const [column, index] of fromMapping) {
    if (index !== undefined) resolved[column] = index;
  }
  return resolved;
}

export function buildServiceM8Import(input: ServiceM8ImportInput): ServiceM8ImportBuild {
  const { rows, s8Table, s8Mapping } = input;
  const layout = matchServiceM8Layout(s8Table.headers);

  // Use the loaded file's header row when it carries the whole contract, so
  // any additional column the operator's ServiceM8 account exports is kept.
  // Otherwise fall back to the canonical contract.
  const useLoadedHeaders = layout.usable && s8Table.headers.length > 0;
  const headers = useLoadedHeaders ? [...s8Table.headers] : [...SERVICEM8_COLUMNS];
  const columnIndex = useLoadedHeaders
    ? resolveColumns(s8Table.headers, s8Mapping)
    : canonicalColumnIndexes();

  const formulaLikeValues: string[] = [];
  const damagedIdentifiers: string[] = [];

  const put = (out: string[], column: ServiceM8Column, value: string): void => {
    const index = columnIndex[column];
    if (index === null || index === undefined || index >= out.length) return;
    out[index] = value;
  };

  const dataRows: string[][] = rows.map((row) => {
    const out = new Array<string>(headers.length).fill('');

    if (row.s8 !== null) {
      // Existing item: start from the untouched source row so every column
      // this application does not own survives byte-for-byte.
      const original = s8Table.rows[row.s8.rowIndex] ?? [];
      for (let c = 0; c < headers.length; c += 1) out[c] = original[c] ?? '';
    } else {
      // New item: only the columns we can justify are filled.
      put(out, 'Item Number', row.supplier?.code ?? '');
      put(out, 'Name', row.supplier?.description ?? '');
      put(out, 'Quantity In Stock', NEW_ITEM_QUANTITY_IN_STOCK);
      put(out, 'Price Includes Taxes', formatIncludesTaxes(input.newItemIncludesTaxes));
      put(out, 'Tax Rate', input.newItemTaxRate);
      put(out, 'Item is Inventoried', NEW_ITEM_IS_INVENTORIED);
      put(out, 'Barcode', row.supplier?.barcode ?? '');
    }

    // The two money columns this application is responsible for.
    if (row.pricing !== null) {
      put(out, 'Price', formatServiceM8Amount(row.pricing.price));
      put(out, 'Purchase Cost', formatServiceM8Amount(row.pricing.purchaseCost));
    }

    for (const value of out) {
      if (isFormulaLike(value)) formulaLikeValues.push(value);
    }
    const identifier = out[columnIndex['Item Number'] ?? 0] ?? '';
    if (isScientificNotation(identifier)) damagedIdentifiers.push(identifier);

    return out;
  });

  return {
    text: encodeServiceM8Csv(headers, dataRows),
    headers,
    rowCount: dataRows.length,
    matchesCanonicalContract:
      headers.length === SERVICEM8_COLUMNS.length &&
      SERVICEM8_COLUMNS.every((column, index) => headers[index] === column),
    missingColumns: layout.missing,
    formulaLikeValues,
    damagedIdentifiers,
    newItemDefaults: [
      { column: 'Quantity In Stock', value: NEW_ITEM_QUANTITY_IN_STOCK },
      {
        column: 'Price Includes Taxes',
        value: formatIncludesTaxes(input.newItemIncludesTaxes),
      },
      { column: 'Tax Rate', value: input.newItemTaxRate },
      { column: 'Item is Inventoried', value: NEW_ITEM_IS_INVENTORIED },
    ],
  };
}

function canonicalColumnIndexes(): Record<ServiceM8Column, number | null> {
  const indexes = {} as Record<ServiceM8Column, number | null>;
  SERVICEM8_COLUMNS.forEach((column, index) => {
    indexes[column] = index;
  });
  return indexes;
}

/**
 * A rollback file in the SAME ServiceM8 format, carrying the ORIGINAL values
 * of exactly the rows this run changes. Importing it restores the prior state,
 * which makes the undo path a one-step operation rather than a manual repair.
 * New items have no prior state and are therefore not included; they are
 * listed in the audit summary instead.
 */
export function buildServiceM8Rollback(input: ServiceM8ImportInput): ServiceM8ImportBuild {
  const { s8Table } = input;
  const layout = matchServiceM8Layout(s8Table.headers);
  const useLoadedHeaders = layout.usable && s8Table.headers.length > 0;
  const headers = useLoadedHeaders ? [...s8Table.headers] : [...SERVICEM8_COLUMNS];

  const dataRows = input.rows
    .filter((row) => row.s8 !== null)
    .map((row) => {
      const original = s8Table.rows[(row.s8 as NonNullable<typeof row.s8>).rowIndex] ?? [];
      return Array.from({ length: headers.length }, (_, c) => original[c] ?? '');
    });

  return {
    text: encodeServiceM8Csv(headers, dataRows),
    headers,
    rowCount: dataRows.length,
    matchesCanonicalContract:
      headers.length === SERVICEM8_COLUMNS.length &&
      SERVICEM8_COLUMNS.every((column, index) => headers[index] === column),
    missingColumns: layout.missing,
    formulaLikeValues: [],
    damagedIdentifiers: [],
    newItemDefaults: [],
  };
}

/** The tax-rate label used for new items when the loaded file offers no clue. */
export const DEFAULT_NEW_ITEM_TAX_RATE = GST_ON_INCOME;
