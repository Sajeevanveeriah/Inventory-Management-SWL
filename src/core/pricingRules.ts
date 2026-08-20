import { amountLessThan, applyMarkup } from './money';

export type MarkupRuleLevel = 'product' | 'brand' | 'global';
export type MarkupSource = MarkupRuleLevel;
export type MarkupRuleValue = string | number;

export interface MarkupRuleInput {
  globalMarkupPercent: MarkupRuleValue;
  brandMarkupPercent?: MarkupRuleValue | null | undefined;
  productMarkupPercent?: MarkupRuleValue | null | undefined;
}

export interface ResolvedMarkupRule {
  markupPercent: string;
  level: MarkupRuleLevel;
  explanation: string;
}

/**
 * Resolve the effective markup without truthiness shortcuts. In particular,
 * zero is an explicit rule value and must not fall through to a broader rule.
 */
export function resolveMarkupRule(input: MarkupRuleInput): ResolvedMarkupRule {
  if (input.productMarkupPercent !== null && input.productMarkupPercent !== undefined) {
    return resolved(input.productMarkupPercent, 'product');
  }
  if (input.brandMarkupPercent !== null && input.brandMarkupPercent !== undefined) {
    return resolved(input.brandMarkupPercent, 'brand');
  }
  return resolved(input.globalMarkupPercent, 'global');
}

function resolved(value: MarkupRuleValue, level: MarkupRuleLevel): ResolvedMarkupRule {
  const markupPercent = String(value);
  return {
    markupPercent,
    level,
    explanation: `${level} markup rule selected explicitly at ${markupPercent}% on cost`,
  };
}

export interface MarkupFloorResult {
  blocked: boolean;
  minimumMarkupPercent: string;
  minimumSellExGst: string;
  proposedSellExGst: string;
  explanation: string;
}

/**
 * Enforce the 30% business floor separately from rule resolution. This keeps
 * an explicit product or brand value observable even when it is not permitted
 * to produce an exportable price.
 */
export function evaluateMarkupFloor(
  costExGst: string,
  proposedSellExGst: string,
  minimumMarkupPercent = '30',
): MarkupFloorResult {
  const minimumSellExGst = applyMarkup(costExGst, minimumMarkupPercent);
  const blocked = amountLessThan(proposedSellExGst, minimumSellExGst);
  return {
    blocked,
    minimumMarkupPercent,
    minimumSellExGst,
    proposedSellExGst,
    explanation: blocked
      ? `Blocked: ${proposedSellExGst} ex GST is below the ${minimumMarkupPercent}% markup floor of ${minimumSellExGst} ex GST`
      : `Passes the ${minimumMarkupPercent}% markup floor of ${minimumSellExGst} ex GST`,
  };
}

export type PriceResolution =
  | {
      ok: true;
      markup: ResolvedMarkupRule;
      sellExGst: string;
      floor: MarkupFloorResult;
    }
  | {
      ok: false;
      reason: 'below-minimum-markup';
      markup: ResolvedMarkupRule;
      sellExGst: string;
      floor: MarkupFloorResult;
    };

/** Resolve the price rule and independently apply the export-blocking floor. */
export function resolvePriceRule(costExGst: string, rules: MarkupRuleInput): PriceResolution {
  const markup = resolveMarkupRule(rules);
  const sellExGst = applyMarkup(costExGst, markup.markupPercent);
  const floor = evaluateMarkupFloor(costExGst, sellExGst);
  return floor.blocked
    ? { ok: false, reason: 'below-minimum-markup', markup, sellExGst, floor }
    : { ok: true, markup, sellExGst, floor };
}
