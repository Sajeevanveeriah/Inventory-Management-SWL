/**
 * Spreadsheet formula-injection protection and filename sanitisation.
 */

const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * A text value is formula-like when it begins with a character a spreadsheet
 * could interpret as the start of a formula. Plain numeric values such as
 * "-5" or "+2.50" are not treated as dangerous.
 */
export function isFormulaLike(text: string): boolean {
  if (text.length === 0) return false;
  const first = text[0] as string;
  if (!FORMULA_TRIGGERS.includes(first)) return false;
  if ((first === '-' || first === '+') && /^[+-]?\d+(\.\d+)?$/.test(text.trim())) {
    return false;
  }
  return true;
}

export interface SanitizedCell {
  value: string;
  flagged: boolean;
}

/**
 * Neutralise a formula-like text value for spreadsheet output by prefixing a
 * single quote (the conventional "treat as text" marker), and report that it
 * was flagged so validation can surface it to the operator.
 * All generated cells are additionally written as string-typed cells, which
 * spreadsheet applications do not evaluate; the prefix is defence in depth.
 */
export function sanitizeForSpreadsheet(text: string): SanitizedCell {
  if (isFormulaLike(text)) {
    return { value: `'${text}`, flagged: true };
  }
  return { value: text, flagged: false };
}

/**
 * Sanitise a name for use in a generated filename: lowercase, ASCII letters,
 * digits and hyphens only.
 */
export function sanitizeFilenamePart(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'unnamed';
}
