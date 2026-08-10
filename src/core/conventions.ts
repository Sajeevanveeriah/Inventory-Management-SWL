import type { S8Record } from './records';
import { GST_ON_INCOME } from './servicem8Format';

/**
 * The tax conventions a ServiceM8 account actually uses.
 *
 * A new item has no existing row to inherit its tax basis from, and guessing
 * wrongly moves its price by the whole GST rate. Rather than invent a default
 * or add a setting the operator would have to understand, the run reads the
 * convention the account already uses most often and reports what it found, so
 * a new item is created consistently with the items around it.
 */
export interface TaxConvention {
  includesTaxes: boolean;
  taxRate: string;
  /** Rows supporting the chosen convention. */
  support: number;
  /** Rows examined. */
  total: number;
  /** True when the file was empty and the documented fallback was used. */
  fallback: boolean;
  /** Rows whose tax basis and tax rate disagree with each other. */
  inconsistent: number;
}

/**
 * The documented fallback: price excludes GST and GST is applied on income.
 * This is internally consistent — a tax-exclusive price with a tax rate that
 * ServiceM8 applies at invoice time.
 */
export const FALLBACK_CONVENTION = { includesTaxes: false, taxRate: GST_ON_INCOME } as const;

export function deriveTaxConvention(records: readonly S8Record[]): TaxConvention {
  const usable = records.filter((record) => !record.issues.some((i) => i.severity === 'error'));
  const counts = new Map<string, { includesTaxes: boolean; taxRate: string; count: number }>();
  let inconsistent = 0;

  for (const record of usable) {
    const taxRate = record.taxRateRaw.trim();
    // A tax-exclusive price with no tax rate cannot produce GST at all, and a
    // tax-inclusive price with no tax rate cannot have its GST component
    // identified. Either way the pair is internally inconsistent.
    if (taxRate === '') inconsistent += 1;
    const key = `${record.includesTaxes ? 'Y' : 'N'}|${taxRate}`;
    const entry = counts.get(key) ?? {
      includesTaxes: record.includesTaxes,
      taxRate,
      count: 0,
    };
    entry.count += 1;
    counts.set(key, entry);
  }

  let best: { includesTaxes: boolean; taxRate: string; count: number } | null = null;
  for (const entry of counts.values()) {
    // Prefer the most common pair; break ties towards a recorded tax rate,
    // because a pair with a tax rate is the internally consistent one.
    if (
      best === null ||
      entry.count > best.count ||
      (entry.count === best.count && best.taxRate === '' && entry.taxRate !== '')
    ) {
      best = entry;
    }
  }

  if (best === null) {
    return {
      includesTaxes: FALLBACK_CONVENTION.includesTaxes,
      taxRate: FALLBACK_CONVENTION.taxRate,
      support: 0,
      total: 0,
      fallback: true,
      inconsistent: 0,
    };
  }

  return {
    includesTaxes: best.includesTaxes,
    taxRate: best.taxRate,
    support: best.count,
    total: usable.length,
    fallback: false,
    inconsistent,
  };
}

/** One-line description of the convention, for the UI and the audit report. */
export function describeTaxConvention(convention: TaxConvention): string {
  const basis = convention.includesTaxes ? 'includes GST' : 'excludes GST';
  const rate = convention.taxRate === '' ? 'no tax rate' : convention.taxRate;
  if (convention.fallback) {
    return `Price ${basis}, ${rate} (documented fallback — the ServiceM8 file provided no usable rows).`;
  }
  return `Price ${basis}, ${rate} (used by ${convention.support} of ${convention.total} existing ServiceM8 items).`;
}
