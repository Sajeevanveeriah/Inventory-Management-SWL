/**
 * The ServiceM8 Materials & Services file contract.
 *
 * This module is the single authority on the shape of the file ServiceM8
 * exports and the shape of the file it accepts back for import. Both are the
 * same nine-column CSV, so a generated import file is verified by proving it
 * is indistinguishable in structure from a genuine ServiceM8 export.
 *
 * The serialisation rule below was established by round-tripping a genuine
 * ServiceM8 Materials export byte-for-byte:
 *
 *   - UTF-8 with no byte order mark
 *   - CRLF terminating EVERY line, including the last
 *   - a field is quoted only when it contains a comma, a double quote, a
 *     carriage return or a line feed
 *   - an embedded double quote is escaped by doubling it
 *
 * `encodeServiceM8Csv` applied to a parsed genuine export reproduces that
 * export's exact bytes. `tests/servicem8Format.test.ts` asserts this.
 */

/** The canonical column contract, in ServiceM8's own order and spelling. */
export const SERVICEM8_COLUMNS = [
  'Item Number',
  'Name',
  'Purchase Cost',
  'Quantity In Stock',
  'Price',
  'Price Includes Taxes',
  'Tax Rate',
  'Item is Inventoried',
  'Barcode',
] as const;

export type ServiceM8Column = (typeof SERVICEM8_COLUMNS)[number];

/** Columns whose absence makes a file unusable as a ServiceM8 import source. */
export const SERVICEM8_ESSENTIAL_COLUMNS: readonly ServiceM8Column[] = [
  'Item Number',
  'Name',
  'Price',
];

/** The two accepted values of the boolean-style ServiceM8 columns. */
export const YES = 'Yes';
export const NO = 'No';

/** The tax rate label ServiceM8 uses for Australian GST on income. */
export const GST_ON_INCOME = 'GST on Income';

/** GST rate applied when a price basis is tax-inclusive. */
export const GST_RATE_PERCENT = '10';

// --- CSV serialisation -----------------------------------------------------

const NEEDS_QUOTING = /[",\r\n]/;

/** Encode one field using ServiceM8's minimal-quoting convention. */
export function encodeCsvField(value: string): string {
  if (!NEEDS_QUOTING.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Encode one record, without a line terminator. */
export function encodeCsvRow(fields: readonly string[]): string {
  return fields.map(encodeCsvField).join(',');
}

/**
 * Encode a complete ServiceM8 CSV document. Every line, including the last,
 * is terminated with CRLF, matching a genuine export exactly.
 */
export function encodeServiceM8Csv(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines = [encodeCsvRow(headers), ...rows.map(encodeCsvRow)];
  return lines.map((line) => `${line}\r\n`).join('');
}

/** The MIME type used for generated ServiceM8 import files. */
export const SERVICEM8_CSV_MIME = 'text/csv;charset=utf-8';

// --- Layout detection ------------------------------------------------------

export interface ServiceM8LayoutMatch {
  /** Column index in the loaded file for each canonical column, or null. */
  indexes: Record<ServiceM8Column, number | null>;
  /** Canonical columns the loaded file does not provide. */
  missing: ServiceM8Column[];
  /** Headers in the loaded file that are not part of the contract. */
  unrecognised: string[];
  /** True when the header row equals the contract exactly, in order. */
  exact: boolean;
  /** True when every canonical column is present, in any order. */
  complete: boolean;
  /** True when at least the essential columns are present. */
  usable: boolean;
}

function headerKey(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolve a loaded header row against the ServiceM8 contract.
 *
 * Matching is by case-insensitive, whitespace-collapsed header name so that a
 * re-saved export still resolves; it never guesses by position. A file that is
 * not a ServiceM8 export simply resolves nothing, which the caller reports.
 */
export function matchServiceM8Layout(headers: readonly string[]): ServiceM8LayoutMatch {
  const lookup = new Map<string, number>();
  headers.forEach((header, index) => {
    const key = headerKey(header);
    if (key !== '' && !lookup.has(key)) lookup.set(key, index);
  });

  const indexes = {} as Record<ServiceM8Column, number | null>;
  const missing: ServiceM8Column[] = [];
  const claimed = new Set<number>();
  for (const column of SERVICEM8_COLUMNS) {
    const index = lookup.get(headerKey(column));
    if (index === undefined) {
      indexes[column] = null;
      missing.push(column);
    } else {
      indexes[column] = index;
      claimed.add(index);
    }
  }

  const unrecognised = headers.filter(
    (header, index) => !claimed.has(index) && header.trim() !== '',
  );
  const exact =
    headers.length === SERVICEM8_COLUMNS.length &&
    SERVICEM8_COLUMNS.every((column, index) => headers[index] === column);

  return {
    indexes,
    missing,
    unrecognised,
    exact,
    complete: missing.length === 0,
    usable: SERVICEM8_ESSENTIAL_COLUMNS.every((column) => indexes[column] !== null),
  };
}

// --- Value conventions -----------------------------------------------------

/**
 * Read a ServiceM8 tax-inclusivity flag. Anything other than a recognised
 * "Yes" is treated as "No", which is the tax-exclusive basis; the caller
 * reports unrecognised text rather than guessing silently.
 */
export function parseIncludesTaxes(raw: string): { includesTaxes: boolean; recognised: boolean } {
  const value = raw.trim().toLowerCase();
  if (value === 'yes' || value === 'y' || value === 'true') {
    return { includesTaxes: true, recognised: true };
  }
  if (value === 'no' || value === 'n' || value === 'false' || value === '') {
    return { includesTaxes: false, recognised: value !== '' };
  }
  return { includesTaxes: false, recognised: false };
}

/** Render a tax-inclusivity flag in ServiceM8's own spelling. */
export function formatIncludesTaxes(includesTaxes: boolean): string {
  return includesTaxes ? YES : NO;
}

/**
 * Excel turns long numeric identifiers into scientific notation when a CSV is
 * opened and re-saved ("9311847775176" becomes "9.31185E+12"). Such a value is
 * irrecoverably lossy: it must never be matched on, and the operator must be
 * told the source file was damaged before it reached this application.
 */
export function isScientificNotation(raw: string): boolean {
  return /^\s*[+-]?\d(?:\.\d+)?[Ee][+-]?\d+\s*$/.test(raw);
}

/**
 * A ServiceM8 numeric cell, rendered the way the export renders one: a plain
 * decimal with no currency symbol, no thousands separator and no padding.
 * Computed amounts arrive as canonical two-decimal strings and stay that way,
 * which every ServiceM8 numeric field accepts.
 */
export function formatServiceM8Amount(canonicalAmount: string): string {
  return canonicalAmount;
}
