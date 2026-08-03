/**
 * Identifier and description normalisation.
 *
 * Identifier rule (documented and deliberately conservative):
 *   - trim surrounding whitespace
 *   - uppercase for case-insensitive comparison
 *   - NOTHING else. Punctuation, internal spacing, leading zeroes and every
 *     other character are preserved exactly, because supplier and ServiceM8
 *     identifiers may be meaning-sensitive.
 */
export function normalizeIdentifier(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Description normalisation used ONLY for similarity suggestions, never for
 * automatic matching: lowercase, trim, collapse whitespace, strip punctuation.
 */
export function normalizeDescription(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
