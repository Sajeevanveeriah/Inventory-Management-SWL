import type { S8Record, SupplierRecord } from './records';
import type { BaseStatus } from './statuses';
import { amountDelta, amountEquals } from './money';
import {
  basisFromIncludesTaxes,
  derivePrice,
  type PriceBasis,
  type PricingResult,
} from './pricing';
import {
  AMBIGUITY_THRESHOLD,
  FeatureDictionary,
  SUGGESTION_THRESHOLD,
  preparedSimilarity,
  similarityBound,
  type PreparedDescription,
} from './similarity';
import type { TaxConvention } from './conventions';

/**
 * Deterministic, safety-first comparison engine.
 *
 * Matching hierarchy (in order, exact only):
 *   1. exact normalised supplier code -> ServiceM8 item number
 *   2. exact match through an operator-approved alias
 * Description similarity NEVER matches automatically; it only produces
 * suggestions for manual review, and a strong similarity on an unmatched
 * supplier item makes that item AMBIGUOUS instead of "new".
 *
 * Change detection is SELL-PRICE driven. A genuine ServiceM8 export records
 * zero purchase cost for most items, so comparing cost against cost would
 * report almost everything as changed while silently passing over items whose
 * selling price has drifted below the markup floor. The engine therefore
 * derives the correct price for each row and compares it with the price the
 * row actually carries.
 *
 * Duplicate supplier codes that agree on cost are collapsed to a single
 * proposal rather than blocked: a price list that lists one product under
 * several categories is normal, and blocking it would bury real exceptions.
 * Duplicates that DISAGREE on cost stay blocked, because the correct cost
 * cannot be determined.
 *
 * ServiceM8 items absent from the supplier file are flagged, never deleted.
 */

export type MatchMethod = 'exact-code' | 'alias' | 'none';

export interface MatchSuggestion {
  itemNumber: string;
  description: string;
  similarity: number;
}

export interface RowMessage {
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface ComparisonRow {
  /** Stable identity used to key operator decisions across re-runs. */
  id: string;
  status: BaseStatus;
  matchMethod: MatchMethod;
  supplier: SupplierRecord | null;
  s8: S8Record | null;
  /** Proposed selling price, on the target row's own GST basis. */
  proposedSell: string | null;
  /** The GST basis the proposed price is expressed on. */
  targetBasis: PriceBasis | null;
  /** Full derivation of the proposed price, for display and audit. */
  pricing: PricingResult | null;
  /** Signed cost movement (supplier cost ex GST − existing purchase cost). */
  costDelta: string | null;
  /** Signed price movement (proposed price − existing ServiceM8 price). */
  priceDelta: string | null;
  /** Other supplier rows that carried the same code and the same cost. */
  duplicateSourceRows: number[];
  messages: RowMessage[];
  suggestions: MatchSuggestion[];
}

export interface ComparisonTotals {
  supplierRecords: number;
  s8Records: number;
  exactMatches: number;
  aliasMatches: number;
  unchanged: number;
  priceChanged: number;
  newItems: number;
  missingFromSupplier: number;
  ambiguous: number;
  invalid: number;
  duplicates: number;
  /** Supplier rows folded into another row because they agreed exactly. */
  duplicatesCollapsed: number;
  blocked: number;
}

export interface ComparisonResult {
  rows: ComparisonRow[];
  totals: ComparisonTotals;
  markupPercent: string;
  /** How the supplier quotes its costs, per the operator's confirmed setting. */
  costBasis: PriceBasis;
  /**
   * False when the operator has not confirmed the supplier's GST basis. The
   * run still classifies every record so the data can be inspected, but export
   * is gated: an unconfirmed basis would move every price by the GST rate.
   */
  costBasisConfirmed: boolean;
  /** Tax convention applied to items this run would create. */
  newItemConvention: TaxConvention;
}

/** Operator-approved aliases: normalised supplier code -> normalised item number. */
export type AliasMap = ReadonlyMap<string, string>;

export interface ComparisonOptions {
  markupPercent: string;
  /** How the supplier quotes its costs; from the confirmed operator setting. */
  costBasis: PriceBasis;
  /** False when the operator has not yet confirmed that basis. */
  costBasisConfirmed: boolean;
  /** Tax convention applied to items that do not yet exist in ServiceM8. */
  newItemConvention: TaxConvention;
  gstRatePercent?: string;
}

export function runComparison(
  supplierRecords: SupplierRecord[],
  s8Records: S8Record[],
  aliases: AliasMap,
  options: ComparisonOptions,
): ComparisonResult {
  const { markupPercent, costBasis, costBasisConfirmed, newItemConvention, gstRatePercent } =
    options;
  const newItemBasis: PriceBasis = newItemConvention.includesTaxes
    ? 'including-gst'
    : 'excluding-gst';
  const rows: ComparisonRow[] = [];
  let duplicateCount = 0;
  let collapsedCount = 0;

  const priceFor = (cost: string, targetBasis: PriceBasis): PricingResult =>
    derivePrice({
      costAmount: cost,
      costBasis,
      markupPercent,
      targetBasis,
      ...(gstRatePercent === undefined ? {} : { gstRatePercent }),
    });

  // --- supplier-side grouping ----------------------------------------------
  // Group by code so a code that appears many times produces one proposal.
  const supplierByCode = groupBy(
    supplierRecords.filter((r) => r.codeNorm !== ''),
    (r) => r.codeNorm,
  );

  /** Codes whose duplicate rows disagree on cost: genuinely undecidable. */
  const conflictingSupplierCodes = new Set<string>();
  /** Code -> the single row that represents it, when duplicates agree. */
  const representatives = new Map<string, SupplierRecord>();
  for (const [code, group] of supplierByCode) {
    const usable = group.filter((r) => !r.issues.some((i) => i.severity === 'error'));
    const costs = new Set(usable.map((r) => r.cost ?? ''));
    if (group.length > 1 && (costs.size > 1 || usable.length === 0)) {
      conflictingSupplierCodes.add(code);
      continue;
    }
    const representative = usable[0] ?? group[0];
    if (representative !== undefined) representatives.set(code, representative);
  }

  const s8ByNumber = groupBy(
    s8Records.filter((r) => r.itemNumberNorm !== ''),
    (r) => r.itemNumberNorm,
  );
  const duplicateS8Numbers = new Set(
    [...s8ByNumber.entries()].filter(([, v]) => v.length > 1).map(([k]) => k),
  );

  // Resolve identifier targets before classification so every ServiceM8 row
  // has at most one supplier owner. Without this reverse ownership check an
  // exact code plus an alias (or two aliases) could both publish contradictory
  // money/history to the same canonical item.
  const targetOwners = new Map<string, SupplierRecord[]>();
  for (const sup of representatives.values()) {
    if (sup.issues.some((issue) => issue.severity === 'error')) continue;
    const aliasTarget = aliases.get(sup.codeNorm);
    const targetNorm = s8ByNumber.has(sup.codeNorm)
      ? sup.codeNorm
      : aliasTarget !== undefined && s8ByNumber.has(aliasTarget)
        ? aliasTarget
        : null;
    if (targetNorm !== null) {
      targetOwners.set(targetNorm, [...(targetOwners.get(targetNorm) ?? []), sup]);
    }
  }
  const multiplyOwnedTargets = new Set(
    [...targetOwners.entries()].filter(([, owners]) => owners.length > 1).map(([target]) => target),
  );

  const matchedS8Rows = new Set<number>();

  // Description features are computed once per record. Rebuilding them for
  // every candidate pair is what makes a real-sized catalogue unusable.
  const dictionary = new FeatureDictionary();
  const suggestionCandidates: { record: S8Record; prepared: PreparedDescription }[] = [];
  for (const s8 of s8Records) {
    if (s8.itemNumberNorm === '' || s8.issues.some((i) => i.severity === 'error')) continue;
    suggestionCandidates.push({ record: s8, prepared: dictionary.prepare(s8.description) });
  }

  // --- supplier-side classification ----------------------------------------
  for (const sup of supplierRecords) {
    const group = supplierByCode.get(sup.codeNorm) ?? [];
    const isRepresentative = representatives.get(sup.codeNorm) === sup;
    const conflicting = conflictingSupplierCodes.has(sup.codeNorm);
    const hasError = sup.issues.some((i) => i.severity === 'error');

    // A duplicate that agrees with its representative is folded away entirely.
    if (!conflicting && !isRepresentative && sup.codeNorm !== '' && !hasError) {
      collapsedCount += 1;
      continue;
    }

    const messages: RowMessage[] = sup.issues.map((i) => ({
      severity: i.severity,
      message: `${i.field}: ${i.message}`,
    }));

    if (hasError) {
      rows.push(
        blankRow({
          id: `sup-row:${sup.rowIndex}`,
          status: 'invalid',
          supplier: sup,
          messages,
        }),
      );
      continue;
    }

    if (conflicting) {
      duplicateCount += 1;
      const others = group
        .filter((r) => r.rowIndex !== sup.rowIndex)
        .map((r) => `row ${r.sourceRow} (${r.costRaw || 'no cost'})`)
        .join(', ');
      messages.push({
        severity: 'error',
        message: `Supplier code “${sup.code}” appears more than once with DIFFERENT costs - also ${others}. The correct cost cannot be determined, so every copy is blocked.`,
      });
      rows.push(
        blankRow({ id: `sup-row:${sup.rowIndex}`, status: 'ambiguous', supplier: sup, messages }),
      );
      continue;
    }

    const duplicateSourceRows = group
      .filter((r) => r.rowIndex !== sup.rowIndex)
      .map((r) => r.sourceRow);
    if (duplicateSourceRows.length > 0) {
      messages.push({
        severity: 'info',
        message: `Supplier code “${sup.code}” also appears on row${
          duplicateSourceRows.length > 1 ? 's' : ''
        } ${duplicateSourceRows.join(', ')} with the same cost. Those copies were folded into this one proposal.`,
      });
    }

    // Matching hierarchy: 1. exact code, 2. approved alias.
    let method: MatchMethod = 'none';
    let targetNorm: string | null = null;
    if (s8ByNumber.has(sup.codeNorm)) {
      method = 'exact-code';
      targetNorm = sup.codeNorm;
    } else {
      const aliasTarget = aliases.get(sup.codeNorm);
      if (aliasTarget !== undefined && s8ByNumber.has(aliasTarget)) {
        method = 'alias';
        targetNorm = aliasTarget;
        messages.push({
          severity: 'info',
          message: `Matched through the approved alias ${sup.code} → ${aliasTarget}.`,
        });
      } else if (aliasTarget !== undefined) {
        messages.push({
          severity: 'warning',
          message: `An approved alias points to ServiceM8 item “${aliasTarget}”, but that item is not present in the loaded ServiceM8 file.`,
        });
      }
    }

    if (targetNorm !== null) {
      if (duplicateS8Numbers.has(targetNorm)) {
        duplicateCount += 1;
        messages.push({
          severity: 'error',
          message: `ServiceM8 item number “${targetNorm}” appears more than once in the ServiceM8 file, so the match is ambiguous.`,
        });
        rows.push(
          blankRow({
            id: `sup:${sup.codeNorm}`,
            status: 'ambiguous',
            matchMethod: method,
            supplier: sup,
            messages,
            duplicateSourceRows,
          }),
        );
        continue;
      }
      const s8 = (s8ByNumber.get(targetNorm) ?? [])[0] as S8Record;
      if (multiplyOwnedTargets.has(targetNorm)) {
        duplicateCount += 1;
        matchedS8Rows.add(s8.rowIndex);
        const otherRows = (targetOwners.get(targetNorm) ?? [])
          .filter((owner) => owner.rowIndex !== sup.rowIndex)
          .map((owner) => `supplier row ${owner.sourceRow}`)
          .join(', ');
        messages.push({
          severity: 'error',
          message: `ServiceM8 item “${s8.itemNumber}” resolves from more than one supplier record, including ${otherRows}. Every colliding record is blocked as ambiguous.`,
        });
        rows.push(
          blankRow({
            id: `sup:${sup.codeNorm}`,
            status: 'ambiguous',
            matchMethod: method,
            supplier: sup,
            s8,
            messages,
            duplicateSourceRows,
          }),
        );
        continue;
      }
      matchedS8Rows.add(s8.rowIndex);
      if (s8.issues.some((i) => i.severity === 'error')) {
        messages.push({
          severity: 'error',
          message: `The matched ServiceM8 row ${s8.sourceRow} has invalid data and blocks this comparison.`,
        });
        rows.push(
          blankRow({
            id: `sup:${sup.codeNorm}`,
            status: 'invalid',
            matchMethod: method,
            supplier: sup,
            s8,
            messages,
            duplicateSourceRows,
          }),
        );
        continue;
      }

      const cost = sup.cost as string;
      const existingSell = s8.existingSell as string;
      const targetBasis = basisFromIncludesTaxes(s8.includesTaxes);
      const pricing = priceFor(cost, targetBasis);
      const costDelta =
        s8.existingCost !== null ? amountDelta(s8.existingCost, pricing.costExGst) : null;
      const priceDelta = amountDelta(existingSell, pricing.price);

      if (s8.existingCost !== null && amountEquals(s8.existingCost, '0.00')) {
        messages.push({
          severity: 'info',
          message:
            'ServiceM8 records no purchase cost for this item, so cost movement is not meaningful. The decision is based on the selling price.',
        });
      }

      const changed = !amountEquals(pricing.price, existingSell);
      rows.push({
        id: `sup:${sup.codeNorm}`,
        status: changed ? 'price-changed' : 'unchanged',
        matchMethod: method,
        supplier: sup,
        s8,
        proposedSell: pricing.price,
        targetBasis,
        pricing,
        costDelta,
        priceDelta,
        duplicateSourceRows,
        messages,
        suggestions: [],
      });
      continue;
    }

    // Unmatched: suggestions from description similarity, review-only.
    const suggestions: MatchSuggestion[] = [];
    const supplierPrepared = dictionary.prepare(sup.description);
    for (const candidate of suggestionCandidates) {
      // Exact upper bound: a pair whose feature counts are too far apart can
      // never reach the threshold, so it is skipped without being scored.
      if (similarityBound(supplierPrepared, candidate.prepared) < SUGGESTION_THRESHOLD) continue;
      const similarity = preparedSimilarity(supplierPrepared, candidate.prepared);
      if (similarity >= SUGGESTION_THRESHOLD) {
        suggestions.push({
          itemNumber: candidate.record.itemNumber,
          description: candidate.record.description,
          similarity,
        });
      }
    }
    suggestions.sort((a, b) => b.similarity - a.similarity);
    const top = suggestions.slice(0, 5);
    const strongest = top[0];

    if (strongest !== undefined && strongest.similarity >= AMBIGUITY_THRESHOLD) {
      messages.push({
        severity: 'error',
        message: `No identifier match, but the description closely resembles ServiceM8 item “${strongest.itemNumber}” (${Math.round(strongest.similarity * 100)}% similar). Treating this as a new item could create a duplicate, so it is blocked until you either approve an alias or confirm it is genuinely new.`,
      });
      rows.push(
        blankRow({
          id: `sup:${sup.codeNorm}`,
          status: 'ambiguous',
          supplier: sup,
          messages,
          suggestions: top,
          duplicateSourceRows,
        }),
      );
      continue;
    }

    const pricing = priceFor(sup.cost as string, newItemBasis);
    messages.push({
      severity: 'info',
      message:
        'Not found in ServiceM8 by identifier or alias. Requires explicit approval to be created.',
    });
    rows.push({
      id: `sup:${sup.codeNorm}`,
      status: 'new-item',
      matchMethod: 'none',
      supplier: sup,
      s8: null,
      proposedSell: pricing.price,
      targetBasis: newItemBasis,
      pricing,
      costDelta: null,
      priceDelta: null,
      duplicateSourceRows,
      messages,
      suggestions: top,
    });
  }

  // --- ServiceM8-side classification ---------------------------------------
  for (const s8 of s8Records) {
    if (matchedS8Rows.has(s8.rowIndex)) continue;
    const messages: RowMessage[] = s8.issues.map((i) => ({
      severity: i.severity,
      message: `${i.field}: ${i.message}`,
    }));
    if (s8.issues.some((i) => i.severity === 'error')) {
      rows.push(blankRow({ id: `s8-row:${s8.rowIndex}`, status: 'invalid', s8, messages }));
      continue;
    }
    if (duplicateS8Numbers.has(s8.itemNumberNorm)) {
      duplicateCount += 1;
      const others = (s8ByNumber.get(s8.itemNumberNorm) ?? [])
        .filter((r) => r.rowIndex !== s8.rowIndex)
        .map((r) => `row ${r.sourceRow}`)
        .join(', ');
      messages.push({
        severity: 'error',
        message: `Duplicate ServiceM8 item number “${s8.itemNumber}” also appears in ${others}. Duplicates are blocked as exceptions.`,
      });
      rows.push(blankRow({ id: `s8-row:${s8.rowIndex}`, status: 'ambiguous', s8, messages }));
      continue;
    }
    messages.push({
      severity: 'info',
      message:
        'Present in ServiceM8 but absent from the supplier file. Flagged for awareness only - this tool never deletes or deactivates items.',
    });
    rows.push(
      blankRow({ id: `s8:${s8.itemNumberNorm}`, status: 'missing-from-supplier', s8, messages }),
    );
  }

  // --- totals ---------------------------------------------------------------
  const count = (status: BaseStatus) => rows.filter((r) => r.status === status).length;
  const totals: ComparisonTotals = {
    supplierRecords: supplierRecords.length,
    s8Records: s8Records.length,
    exactMatches: rows.filter((r) => r.matchMethod === 'exact-code' && !isBlockedStatus(r.status))
      .length,
    aliasMatches: rows.filter((r) => r.matchMethod === 'alias' && !isBlockedStatus(r.status))
      .length,
    unchanged: count('unchanged'),
    priceChanged: count('price-changed'),
    newItems: count('new-item'),
    missingFromSupplier: count('missing-from-supplier'),
    ambiguous: count('ambiguous'),
    invalid: count('invalid'),
    duplicates: duplicateCount,
    duplicatesCollapsed: collapsedCount,
    blocked: count('ambiguous') + count('invalid'),
  };

  return { rows, totals, markupPercent, costBasis, costBasisConfirmed, newItemConvention };
}

function isBlockedStatus(status: BaseStatus): boolean {
  return status === 'ambiguous' || status === 'invalid';
}

interface BlankRowInput {
  id: string;
  status: BaseStatus;
  matchMethod?: MatchMethod;
  supplier?: SupplierRecord | null;
  s8?: S8Record | null;
  messages: RowMessage[];
  suggestions?: MatchSuggestion[];
  duplicateSourceRows?: number[];
}

/** A row carrying no proposal: blocked, invalid or informational. */
function blankRow(input: BlankRowInput): ComparisonRow {
  return {
    id: input.id,
    status: input.status,
    matchMethod: input.matchMethod ?? 'none',
    supplier: input.supplier ?? null,
    s8: input.s8 ?? null,
    proposedSell: null,
    targetBasis: null,
    pricing: null,
    costDelta: null,
    priceDelta: null,
    duplicateSourceRows: input.duplicateSourceRows ?? [],
    messages: input.messages,
    suggestions: input.suggestions ?? [],
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}
