import { addGst, applyMarkup, formatAmount, removeGst } from './money';
import { GST_RATE_PERCENT } from './servicem8Format';
import type { TaxHandling } from './settings';

/**
 * GST-aware sell price derivation.
 *
 * ServiceM8 records each material's price against one of two bases, per row,
 * in its "Price Includes Taxes" column. A single marked-up number cannot be
 * written into both bases: doing so under-prices every tax-inclusive row by
 * exactly the GST rate. This module makes the basis explicit on both sides —
 * how the supplier's cost is quoted, and how the target ServiceM8 row stores
 * its price — and converts between them once, in one place.
 *
 * The markup is always applied to the tax-EXCLUSIVE cost, because GST is not
 * a cost to a registered business; it is collected and remitted. Marking up a
 * tax-inclusive cost would silently mark up the tax as well.
 */

export type PriceBasis = 'excluding-gst' | 'including-gst';

export const PRICE_BASIS_LABELS: Record<PriceBasis, string> = {
  'excluding-gst': 'Excludes GST',
  'including-gst': 'Includes GST',
};

export interface PricingInput {
  /** Canonical 2-decimal supplier cost. */
  costAmount: string;
  /** How the supplier quotes that cost. */
  costBasis: PriceBasis;
  /** Markup on cost, as a percentage, e.g. "30". */
  markupPercent: string;
  /** The basis the target ServiceM8 row stores its price in. */
  targetBasis: PriceBasis;
  /** GST rate percentage; defaults to the Australian rate. */
  gstRatePercent?: string;
}

export interface PricingResult {
  /** Supplier cost expressed excluding GST — the markup base. */
  costExGst: string;
  /** Marked-up sell price excluding GST. */
  sellExGst: string;
  /** Marked-up sell price including GST. */
  sellIncGst: string;
  /** The value to write into the ServiceM8 "Price" column for this row. */
  price: string;
  /** The value to write into the ServiceM8 "Purchase Cost" column. */
  purchaseCost: string;
  /** Human-readable derivation shown wherever the proposed price appears. */
  explanation: string;
}

/**
 * Derive the ServiceM8 price for one row. Pure; every amount in and out is a
 * canonical two-decimal string.
 */
export function derivePrice(input: PricingInput): PricingResult {
  const gstRate = input.gstRatePercent ?? GST_RATE_PERCENT;
  const costExGst =
    input.costBasis === 'including-gst'
      ? removeGst(input.costAmount, gstRate)
      : input.costAmount;
  const sellExGst = applyMarkup(costExGst, input.markupPercent);
  const sellIncGst = addGst(sellExGst, gstRate);
  const price = input.targetBasis === 'including-gst' ? sellIncGst : sellExGst;

  // ServiceM8's "Purchase Cost" is a cost field and is recorded on the same
  // basis the supplier quotes, converted to exclude GST for consistency with
  // the markup base.
  const purchaseCost = costExGst;

  const steps: string[] = [];
  if (input.costBasis === 'including-gst') {
    steps.push(
      `${formatAmount(input.costAmount)} incl GST ÷ ${gstFactorLabel(gstRate)} = ${formatAmount(costExGst)} ex GST`,
    );
  }
  steps.push(
    `${formatAmount(costExGst)} × ${markupFactorLabel(input.markupPercent)} = ${formatAmount(sellExGst)} ex GST`,
  );
  if (input.targetBasis === 'including-gst') {
    steps.push(
      `${formatAmount(sellExGst)} × ${gstFactorLabel(gstRate)} = ${formatAmount(sellIncGst)} incl GST`,
    );
  }

  return {
    costExGst,
    sellExGst,
    sellIncGst,
    price,
    purchaseCost,
    explanation: steps.join('; '),
  };
}

function markupFactorLabel(markupPercent: string): string {
  const factor = 1 + Number(markupPercent) / 100;
  return `${trimFactor(factor)} (${markupPercent}% on cost)`;
}

function gstFactorLabel(gstRatePercent: string): string {
  const factor = 1 + Number(gstRatePercent) / 100;
  return `${trimFactor(factor)} (${gstRatePercent}% GST)`;
}

function trimFactor(value: number): string {
  return String(Number(value.toFixed(6)));
}

/** Map a ServiceM8 "Price Includes Taxes" flag to a price basis. */
export function basisFromIncludesTaxes(includesTaxes: boolean): PriceBasis {
  return includesTaxes ? 'including-gst' : 'excluding-gst';
}

/**
 * The supplier's cost basis, taken from the operator's confirmed setting.
 * `null` means the operator has not declared it, which blocks pricing.
 */
export function costBasisFromTaxHandling(handling: TaxHandling): PriceBasis | null {
  if (handling === 'prices-ex-gst') return 'excluding-gst';
  if (handling === 'prices-inc-gst') return 'including-gst';
  return null;
}
