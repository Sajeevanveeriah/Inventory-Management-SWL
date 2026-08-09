import type { S8Record, SupplierRecord } from "./records";
import type { BaseStatus } from "./statuses";
import { amountDelta, amountEquals, applyMarkup } from "./money";
import {
  AMBIGUITY_THRESHOLD,
  SUGGESTION_THRESHOLD,
  descriptionSimilarity,
} from "./similarity";

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
 * Duplicate identifiers in either file are blocked as exceptions.
 * ServiceM8 items absent from the supplier file are flagged, never deleted.
 */

export type MatchMethod = "exact-code" | "alias" | "none";

export interface MatchSuggestion {
  itemNumber: string;
  description: string;
  similarity: number;
}

export interface RowMessage {
  severity: "error" | "warning" | "info";
  message: string;
}

export interface ComparisonRow {
  /** Stable identity used to key operator decisions across re-runs. */
  id: string;
  status: BaseStatus;
  matchMethod: MatchMethod;
  supplier: SupplierRecord | null;
  s8: S8Record | null;
  /** Proposed selling price (cost × markup), for matched and new items. */
  proposedSell: string | null;
  /** Signed cost movement (supplier cost − existing cost) for matched items. */
  costDelta: string | null;
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
  blocked: number;
}

export interface ComparisonResult {
  rows: ComparisonRow[];
  totals: ComparisonTotals;
  markupPercent: string;
}

/** Operator-approved aliases: normalised supplier code -> normalised item number. */
export type AliasMap = ReadonlyMap<string, string>;

export function runComparison(
  supplierRecords: SupplierRecord[],
  s8Records: S8Record[],
  aliases: AliasMap,
  markupPercent: string,
): ComparisonResult {
  const rows: ComparisonRow[] = [];
  let duplicateCount = 0;

  // --- duplicate detection --------------------------------------------------
  const supplierByCode = groupBy(
    supplierRecords.filter((r) => r.codeNorm !== ""),
    (r) => r.codeNorm,
  );
  const duplicateSupplierCodes = new Set(
    [...supplierByCode.entries()]
      .filter(([, v]) => v.length > 1)
      .map(([k]) => k),
  );
  const s8ByNumber = groupBy(
    s8Records.filter((r) => r.itemNumberNorm !== ""),
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
  for (const sup of supplierRecords) {
    if (
      sup.issues.some((issue) => issue.severity === "error") ||
      duplicateSupplierCodes.has(sup.codeNorm)
    ) {
      continue;
    }
    const aliasTarget = aliases.get(sup.codeNorm);
    const targetNorm = s8ByNumber.has(sup.codeNorm)
      ? sup.codeNorm
      : aliasTarget !== undefined && s8ByNumber.has(aliasTarget)
        ? aliasTarget
        : null;
    if (targetNorm !== null) {
      targetOwners.set(targetNorm, [
        ...(targetOwners.get(targetNorm) ?? []),
        sup,
      ]);
    }
  }
  const multiplyOwnedTargets = new Set(
    [...targetOwners.entries()]
      .filter(([, owners]) => owners.length > 1)
      .map(([target]) => target),
  );

  const matchedS8Rows = new Set<number>();

  // --- supplier-side classification ----------------------------------------
  for (const sup of supplierRecords) {
    const messages: RowMessage[] = sup.issues.map((i) => ({
      severity: i.severity,
      message: `${i.field}: ${i.message}`,
    }));
    const hasError = sup.issues.some((i) => i.severity === "error");

    if (hasError) {
      rows.push(
        row(
          `sup-row:${sup.rowIndex}`,
          "invalid",
          "none",
          sup,
          null,
          null,
          null,
          messages,
        ),
      );
      continue;
    }

    if (duplicateSupplierCodes.has(sup.codeNorm)) {
      duplicateCount += 1;
      const others = (supplierByCode.get(sup.codeNorm) ?? [])
        .filter((r) => r.rowIndex !== sup.rowIndex)
        .map((r) => `row ${r.sourceRow}`)
        .join(", ");
      messages.push({
        severity: "error",
        message: `Duplicate supplier code “${sup.code}” also appears in ${others}. Duplicates are blocked because the correct cost cannot be determined.`,
      });
      rows.push(
        row(
          `sup-row:${sup.rowIndex}`,
          "ambiguous",
          "none",
          sup,
          null,
          null,
          null,
          messages,
        ),
      );
      continue;
    }

    // Matching hierarchy: 1. exact code, 2. approved alias.
    let method: MatchMethod = "none";
    let targetNorm: string | null = null;
    if (s8ByNumber.has(sup.codeNorm)) {
      method = "exact-code";
      targetNorm = sup.codeNorm;
    } else {
      const aliasTarget = aliases.get(sup.codeNorm);
      if (aliasTarget !== undefined && s8ByNumber.has(aliasTarget)) {
        method = "alias";
        targetNorm = aliasTarget;
        messages.push({
          severity: "info",
          message: `Matched through the approved alias ${sup.code} → ${aliasTarget}.`,
        });
      } else if (aliasTarget !== undefined) {
        messages.push({
          severity: "warning",
          message: `An approved alias points to ServiceM8 item “${aliasTarget}”, but that item is not present in the loaded ServiceM8 file.`,
        });
      }
    }

    if (targetNorm !== null) {
      if (duplicateS8Numbers.has(targetNorm)) {
        duplicateCount += 1;
        messages.push({
          severity: "error",
          message: `ServiceM8 item number “${targetNorm}” appears more than once in the ServiceM8 file, so the match is ambiguous.`,
        });
        rows.push(
          row(
            `sup:${sup.codeNorm}`,
            "ambiguous",
            method,
            sup,
            null,
            null,
            null,
            messages,
          ),
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
          .join(", ");
        messages.push({
          severity: "error",
          message: `ServiceM8 item “${s8.itemNumber}” resolves from more than one supplier record, including ${otherRows}. Every colliding record is blocked as ambiguous.`,
        });
        rows.push(
          row(
            `sup:${sup.codeNorm}`,
            "ambiguous",
            method,
            sup,
            s8,
            null,
            null,
            messages,
          ),
        );
        continue;
      }
      matchedS8Rows.add(s8.rowIndex);
      if (s8.issues.some((i) => i.severity === "error")) {
        messages.push({
          severity: "error",
          message: `The matched ServiceM8 row ${s8.sourceRow} has invalid data and blocks this comparison.`,
        });
        rows.push(
          row(
            `sup:${sup.codeNorm}`,
            "invalid",
            method,
            sup,
            s8,
            null,
            null,
            messages,
          ),
        );
        continue;
      }
      const cost = sup.cost as string;
      const existingCost = s8.existingCost as string;
      const proposed = applyMarkup(cost, markupPercent);
      const delta = amountDelta(existingCost, cost);
      if (amountEquals(cost, existingCost)) {
        rows.push(
          row(
            `sup:${sup.codeNorm}`,
            "unchanged",
            method,
            sup,
            s8,
            proposed,
            delta,
            messages,
          ),
        );
      } else {
        rows.push(
          row(
            `sup:${sup.codeNorm}`,
            "price-changed",
            method,
            sup,
            s8,
            proposed,
            delta,
            messages,
          ),
        );
      }
      continue;
    }

    // Unmatched: suggestions from description similarity, review-only.
    const suggestions: MatchSuggestion[] = [];
    for (const s8 of s8Records) {
      if (
        s8.itemNumberNorm === "" ||
        s8.issues.some((i) => i.severity === "error")
      )
        continue;
      const similarity = descriptionSimilarity(sup.description, s8.description);
      if (similarity >= SUGGESTION_THRESHOLD) {
        suggestions.push({
          itemNumber: s8.itemNumber,
          description: s8.description,
          similarity,
        });
      }
    }
    suggestions.sort((a, b) => b.similarity - a.similarity);
    const top = suggestions.slice(0, 5);
    const strongest = top[0];

    if (
      strongest !== undefined &&
      strongest.similarity >= AMBIGUITY_THRESHOLD
    ) {
      messages.push({
        severity: "error",
        message: `No identifier match, but the description closely resembles ServiceM8 item “${strongest.itemNumber}” (${Math.round(strongest.similarity * 100)}% similar). Treating this as a new item could create a duplicate, so it is blocked until you either approve an alias or confirm it is genuinely new.`,
      });
      rows.push(
        row(
          `sup:${sup.codeNorm}`,
          "ambiguous",
          "none",
          sup,
          null,
          null,
          null,
          messages,
          top,
        ),
      );
      continue;
    }

    const proposed = applyMarkup(sup.cost as string, markupPercent);
    messages.push({
      severity: "info",
      message:
        "Not found in ServiceM8 by identifier or alias. Requires explicit approval to be created.",
    });
    rows.push(
      row(
        `sup:${sup.codeNorm}`,
        "new-item",
        "none",
        sup,
        null,
        proposed,
        null,
        messages,
        top,
      ),
    );
  }

  // --- ServiceM8-side classification ---------------------------------------
  for (const s8 of s8Records) {
    if (matchedS8Rows.has(s8.rowIndex)) continue;
    const messages: RowMessage[] = s8.issues.map((i) => ({
      severity: i.severity,
      message: `${i.field}: ${i.message}`,
    }));
    if (s8.issues.some((i) => i.severity === "error")) {
      rows.push(
        row(
          `s8-row:${s8.rowIndex}`,
          "invalid",
          "none",
          null,
          s8,
          null,
          null,
          messages,
        ),
      );
      continue;
    }
    if (duplicateS8Numbers.has(s8.itemNumberNorm)) {
      duplicateCount += 1;
      const others = (s8ByNumber.get(s8.itemNumberNorm) ?? [])
        .filter((r) => r.rowIndex !== s8.rowIndex)
        .map((r) => `row ${r.sourceRow}`)
        .join(", ");
      messages.push({
        severity: "error",
        message: `Duplicate ServiceM8 item number “${s8.itemNumber}” also appears in ${others}. Duplicates are blocked as exceptions.`,
      });
      rows.push(
        row(
          `s8-row:${s8.rowIndex}`,
          "ambiguous",
          "none",
          null,
          s8,
          null,
          null,
          messages,
        ),
      );
      continue;
    }
    messages.push({
      severity: "info",
      message:
        "Present in ServiceM8 but absent from the supplier file. Flagged for awareness only — this tool never deletes or deactivates items.",
    });
    rows.push(
      row(
        `s8:${s8.itemNumberNorm}`,
        "missing-from-supplier",
        "none",
        null,
        s8,
        null,
        null,
        messages,
      ),
    );
  }

  // --- totals ---------------------------------------------------------------
  const count = (status: BaseStatus) =>
    rows.filter((r) => r.status === status).length;
  const totals: ComparisonTotals = {
    supplierRecords: supplierRecords.length,
    s8Records: s8Records.length,
    exactMatches: rows.filter(
      (r) => r.matchMethod === "exact-code" && !isBlockedStatus(r.status),
    ).length,
    aliasMatches: rows.filter(
      (r) => r.matchMethod === "alias" && !isBlockedStatus(r.status),
    ).length,
    unchanged: count("unchanged"),
    priceChanged: count("price-changed"),
    newItems: count("new-item"),
    missingFromSupplier: count("missing-from-supplier"),
    ambiguous: count("ambiguous"),
    invalid: count("invalid"),
    duplicates: duplicateCount,
    blocked: count("ambiguous") + count("invalid"),
  };

  return { rows, totals, markupPercent };
}

function isBlockedStatus(status: BaseStatus): boolean {
  return status === "ambiguous" || status === "invalid";
}

function row(
  id: string,
  status: BaseStatus,
  matchMethod: MatchMethod,
  supplier: SupplierRecord | null,
  s8: S8Record | null,
  proposedSell: string | null,
  costDelta: string | null,
  messages: RowMessage[],
  suggestions: MatchSuggestion[] = [],
): ComparisonRow {
  return {
    id,
    status,
    matchMethod,
    supplier,
    s8,
    proposedSell,
    costDelta,
    messages,
    suggestions,
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
