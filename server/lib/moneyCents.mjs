/**
 * Server-side money: AUD in integer minor units (cents), BigInt arithmetic.
 * No binary floating point ever touches a monetary value on this path.
 * Amounts cross the API boundary as integer cents plus a fixed 2-decimal
 * string for display, mirroring the client's big.js convention.
 */

/** Parse a fixed-decimal AUD string ("130.00", "9.9", "100") to integer cents. */
export const MAX_SUPPORTED_CENTS = 1_000_000_000;

export function parseAmountToCents(raw) {
  const trimmed = String(raw).trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const whole = BigInt(match[1]);
  const centsPart = (match[2] ?? "").padEnd(2, "0");
  const amount = whole * 100n + BigInt(centsPart || "0");
  if (amount > BigInt(MAX_SUPPORTED_CENTS)) return null;
  return Number(amount);
}

/** Format integer cents as a canonical fixed 2-decimal string, e.g. 13000 -> "130.00". */
export function centsToAmount(cents) {
  const negative = cents < 0;
  const abs = BigInt(Math.trunc(Math.abs(cents)));
  const whole = abs / 100n;
  const rem = abs % 100n;
  return `${negative ? "-" : ""}${whole}.${rem.toString().padStart(2, "0")}`;
}

/**
 * The settled business rule, in integer cents: minimum sell = cost x 1.30
 * (markup on cost), rounded half up. 10000 cents -> 13000 cents.
 */
export function minimumSellPriceCents(costCents) {
  const scaled = BigInt(costCents) * 130n; // cost x 130, still in cents x 100
  const rounded = (scaled + 50n) / 100n; // integer division with half-up rounding
  return Number(rounded);
}
