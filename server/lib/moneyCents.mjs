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
  const centsPart = (match[2] ?? '').padEnd(2, '0');
  const amount = whole * 100n + BigInt(centsPart || '0');
  if (amount > BigInt(MAX_SUPPORTED_CENTS)) return null;
  return Number(amount);
}

/** Format integer cents as a canonical fixed 2-decimal string, e.g. 13000 -> "130.00". */
export function centsToAmount(cents) {
  const negative = cents < 0;
  const abs = BigInt(Math.trunc(Math.abs(cents)));
  const whole = abs / 100n;
  const rem = abs % 100n;
  return `${negative ? '-' : ''}${whole}.${rem.toString().padStart(2, '0')}`;
}

function roundHalfUpRatio(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

/** Convert an AUD amount to its GST-exclusive integer-cent basis. */
export function amountExGstCents(amountCents, basis) {
  if (basis === 'ex-gst') return amountCents;
  if (basis !== 'inc-gst') throw new TypeError('A confirmed GST basis is required.');
  return Number(roundHalfUpRatio(BigInt(amountCents) * 10n, 11n));
}

/**
 * Apply a percentage expressed in hundredths (3000 = 30.00%) to the
 * GST-exclusive cost and return the requested GST basis, rounding half up at
 * each currency boundary to match the application pricing contract.
 */
export function deriveSellPriceCents(costCents, costBasis, markupHundredths, sellPriceBasis) {
  const costExGst = amountExGstCents(costCents, costBasis);
  const sellExGst = Number(
    roundHalfUpRatio(BigInt(costExGst) * (10_000n + BigInt(markupHundredths)), 10_000n),
  );
  if (sellPriceBasis === 'ex-gst') return sellExGst;
  if (sellPriceBasis !== 'inc-gst')
    throw new TypeError('A confirmed sell-price GST basis is required.');
  return Number(roundHalfUpRatio(BigInt(sellExGst) * 110n, 100n));
}

/**
 * The settled business rule, in integer cents: minimum sell = cost x 1.30
 * (markup on cost), rounded half up. 10000 cents -> 13000 cents.
 */
export function minimumSellPriceCents(costCents) {
  return Number(roundHalfUpRatio(BigInt(costCents) * 130n, 100n));
}
