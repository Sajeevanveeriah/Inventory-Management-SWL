import Big from 'big.js';

/**
 * Decimal-safe money handling.
 *
 * All monetary arithmetic uses big.js decimal values — never binary floats.
 * Amounts cross module boundaries as fixed two-decimal strings ("130.00")
 * so application state stays serialisable and exact.
 *
 * Rounding rule (documented, tested, shown in the UI):
 *   "round half up" to 2 decimal places — the common commercial rule where
 *   exactly .005 rounds away from zero (1.005 -> 1.01).
 */

export const CURRENCY = 'AUD';
export const ROUNDING_RULE_LABEL = 'Round half up to 2 decimal places';

/** big.js rounding mode 3 is ROUND_UP (away from zero); 1 is ROUND_HALF_UP. */
const HALF_UP = Big.roundHalfUp;

export interface MoneyParseOk {
  ok: true;
  /** Canonical fixed 2-decimal string, e.g. "130.00". */
  amount: string;
  /** True when the source had more than 2 decimal places and was rounded. */
  wasRounded: boolean;
}
export interface MoneyParseError {
  ok: false;
  error: string;
}
export type MoneyParseResult = MoneyParseOk | MoneyParseError;

const CURRENCY_PREFIX = /^(aud|au\$|a\$|\$)\s*/i;

/**
 * Parse an operator-supplied or spreadsheet-supplied currency value.
 * Accepts: "100", "100.5", "1,234.56", "$100.00", "AUD 100.00", "A$100".
 * Rejects: empty values, negative amounts, and anything non-numeric.
 * Values with more than 2 decimal places are rounded half-up and flagged.
 */
export function parseMoney(raw: string): MoneyParseResult {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: 'Missing value' };
  }
  let cleaned = trimmed.replace(CURRENCY_PREFIX, '');
  const negative = /^\(.*\)$/.test(cleaned) || cleaned.startsWith('-');
  if (negative) {
    return { ok: false, error: 'Negative amounts are not valid costs or prices' };
  }
  cleaned = cleaned.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, error: `Not a recognisable ${CURRENCY} amount: “${truncate(raw)}”` };
  }
  try {
    const value = new Big(cleaned);
    const rounded = value.round(2, HALF_UP);
    return { ok: true, amount: rounded.toFixed(2), wasRounded: !rounded.eq(value) };
  } catch {
    return { ok: false, error: `Not a recognisable ${CURRENCY} amount: “${truncate(raw)}”` };
  }
}

function truncate(s: string): string {
  const t = s.trim();
  return t.length > 40 ? `${t.slice(0, 37)}…` : t;
}

/**
 * Apply a percentage markup on cost: sell = cost × (1 + markup/100),
 * rounded half-up to 2 decimal places.
 * `costAmount` must be a canonical amount string from parseMoney.
 */
export function applyMarkup(costAmount: string, markupPercent: string | number): string {
  const cost = new Big(costAmount);
  const factor = new Big(1).plus(new Big(markupPercent).div(100));
  return cost.times(factor).round(2, HALF_UP).toFixed(2);
}

/** Exact comparison of two canonical amount strings. */
export function amountEquals(a: string, b: string): boolean {
  return new Big(a).eq(new Big(b));
}

/** b - a as a signed fixed 2-decimal string (positive = increase). */
export function amountDelta(from: string, to: string): string {
  return new Big(to).minus(new Big(from)).toFixed(2);
}

/** Format a canonical amount for display, e.g. "$1,234.50". Currency is AUD. */
export function formatAmount(amount: string): string {
  const [whole = '0', cents = '00'] = amount.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}.${cents}`;
}

/** Format with the explicit AUD label for audit output: "AUD 1,234.50". */
export function formatAud(amount: string): string {
  return `${CURRENCY} ${formatAmount(amount).replace('$', '')}`;
}

/** Human-readable formula string shown wherever a proposed price appears. */
export function markupFormula(costAmount: string, markupPercent: string | number): string {
  const factor = new Big(1).plus(new Big(markupPercent).div(100));
  return `${formatAmount(costAmount)} × ${factor.toString()} = ${formatAmount(
    applyMarkup(costAmount, markupPercent),
  )}`;
}
