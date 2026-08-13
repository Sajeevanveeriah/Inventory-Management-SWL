/**
 * Server-side query normalisation. One text box on the client: the server
 * decides whether the input looks like an identifier (part number, SKU,
 * barcode) or free text, and shapes the provider query accordingly. The user
 * never selects a search type.
 */

/** Trim, collapse whitespace. Case is preserved for display, lowered for matching. */
export function normaliseQuery(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Classify a normalised query.
 *  - "barcode": 8/12/13/14 digit numeric string (EAN-8, UPC-A, EAN-13, GTIN-14)
 *  - "identifier": single token containing at least one digit (part no. / SKU)
 *  - "free-text": everything else
 */
export function classifyQuery(normalised) {
  if (normalised === '') return 'empty';
  if (/^\d{8}$|^\d{12,14}$/.test(normalised)) return 'barcode';
  if (!normalised.includes(' ') && /\d/.test(normalised) && /[a-z0-9]/i.test(normalised))
    return 'identifier';
  return 'free-text';
}

/**
 * Build the provider-facing query. Identifiers and barcodes are quoted so the
 * search engine treats them as exact terms; free text passes through.
 */
export function buildProviderQuery(raw) {
  const normalised = normaliseQuery(raw);
  const kind = classifyQuery(normalised);
  const providerQuery =
    kind === 'identifier' || kind === 'barcode' ? `"${normalised}"` : normalised;
  return { normalised, kind, providerQuery };
}
