import type { ComparisonRow } from './compare';
import type { BaseStatus } from './statuses';
import { normalizeDescription, normalizeIdentifier } from './normalize';
import { descriptionSimilarity } from './similarity';
import type { ItemKind, ProductSearchDocument } from './catalogue';
import type { MarkupSource } from './pricingRules';
import type { PriceBasis } from './pricing';

/**
 * Deterministic product search across the loaded supplier and ServiceM8 data.
 *
 * Ranking is exact-first and fully reproducible:
 *   100  exact normalised code or item-number match
 *    90  code or item number starts with the query
 *    75  code or item number contains the query
 *    60  every query token appears in the description
 *  40-59 some query tokens appear (proportional)
 *  20-39 description similarity above the fuzzy threshold (proportional)
 *
 * An empty query returns every row (subject to status filters) in stable
 * source order so the same view doubles as the inventory table.
 */

export interface SearchFilters {
  statuses?: ReadonlySet<BaseStatus>;
}

export interface SearchHit {
  row: ComparisonRow;
  score: number;
  /** Which part of the record matched, for display. */
  matchedOn: 'code' | 'item-number' | 'description' | 'none';
}

/** Minimum fuzzy description similarity considered a hit at all. */
export const SEARCH_FUZZY_THRESHOLD = 0.45;

function scoreIdentifier(identifier: string | undefined, queryNorm: string): number {
  if (!identifier || queryNorm === '') return 0;
  const idNorm = normalizeIdentifier(identifier);
  if (idNorm === queryNorm) return 100;
  if (idNorm.startsWith(queryNorm)) return 90;
  if (idNorm.includes(queryNorm)) return 75;
  return 0;
}

function scoreDescription(
  description: string | undefined,
  query: string,
  queryTokens: readonly string[],
): number {
  if (!description) return 0;
  if (queryTokens.length === 0) return 0;
  const descNorm = normalizeDescription(description);
  const words = new Set(descNorm.split(' '));
  // Whole-word matches always count; substring matches only for tokens long
  // enough not to match accidentally (so "a" never matches everything).
  const present = queryTokens.filter(
    (t) => words.has(t) || (t.length >= 3 && descNorm.includes(t)),
  ).length;
  if (present === queryTokens.length) return 60;
  if (present > 0) return 40 + Math.round((present / queryTokens.length) * 19);
  const similarity = descriptionSimilarity(description, query);
  if (similarity >= SEARCH_FUZZY_THRESHOLD) return 20 + Math.round(similarity * 19);
  return 0;
}

export function searchRows(
  rows: readonly ComparisonRow[],
  query: string,
  filters: SearchFilters = {},
): SearchHit[] {
  const trimmed = query.trim();
  const queryNorm = normalizeIdentifier(trimmed);
  const queryTokens = normalizeDescription(trimmed).split(' ').filter(Boolean);
  const statusSet = filters.statuses;

  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (statusSet && statusSet.size > 0 && !statusSet.has(row.status)) continue;
    if (trimmed === '') {
      hits.push({ row, score: 0, matchedOn: 'none' });
      continue;
    }
    const codeScore = scoreIdentifier(row.supplier?.code, queryNorm);
    const itemScore = scoreIdentifier(row.s8?.itemNumber, queryNorm);
    const supplierDescription = row.supplier?.description;
    const serviceDescription = row.s8?.description;
    let descScore = 0;
    // Every identifier match outranks the highest possible description score.
    // Avoid normalising and scoring descriptions that cannot affect ranking.
    if (codeScore === 0 && itemScore === 0) {
      descScore = scoreDescription(supplierDescription, trimmed, queryTokens);
      if (serviceDescription && serviceDescription !== supplierDescription) {
        descScore = Math.max(descScore, scoreDescription(serviceDescription, trimmed, queryTokens));
      }
    }
    const score = Math.max(codeScore, itemScore, descScore);
    if (score === 0) continue;
    const matchedOn =
      score === codeScore ? 'code' : score === itemScore ? 'item-number' : 'description';
    hits.push({ row, score, matchedOn });
  }

  if (trimmed === '') return hits;
  return hits.sort(
    (a, b) =>
      b.score - a.score ||
      keyOf(a.row).localeCompare(keyOf(b.row)) ||
      a.row.id.localeCompare(b.row.id),
  );
}

function keyOf(row: ComparisonRow): string {
  return row.supplier?.code ?? row.s8?.itemNumber ?? row.id;
}

export type CataloguePriceResolution =
  | {
      kind: 'resolved';
      offerId: string;
      supplierId: string;
      supplierName: string;
      supplierSku: string;
      purchaseCost: string;
      costBasis: PriceBasis;
      currency: 'AUD';
      observedAt: string;
      markupPercent: string;
      markupSource: MarkupSource;
      sellPrice: string;
      sellPriceBasis: PriceBasis;
      explanation: string;
    }
  | {
      kind: 'ambiguous' | 'unavailable';
      explanation: string;
      candidateOfferIds: readonly string[];
    }
  | {
      kind: 'identity-only';
      explanation: string;
    };

export interface CatalogueSearchRecord {
  document: ProductSearchDocument;
  price: CataloguePriceResolution;
}

export type CatalogueMatchMethod =
  | 'xero-item-code'
  | 'servicem8-item-number'
  | 'supplier-sku'
  | 'approved-alias'
  | 'barcode-gtin'
  | 'brand'
  | 'description'
  | 'none';

export interface CatalogueSearchHit {
  document: ProductSearchDocument;
  price: CataloguePriceResolution;
  score: number;
  matchedOn: CatalogueMatchMethod;
}

function bestCatalogueIdentifier(
  document: ProductSearchDocument,
  queryNorm: string,
): { score: number; matchedOn: CatalogueMatchMethod } {
  const candidates: Array<{ score: number; matchedOn: CatalogueMatchMethod }> = [
    {
      score: scoreIdentifier(document.xeroItemCode ?? undefined, queryNorm) + 30,
      matchedOn: 'xero-item-code' as const,
    },
    {
      score: scoreIdentifier(document.servicem8ItemNumber ?? undefined, queryNorm) + 25,
      matchedOn: 'servicem8-item-number' as const,
    },
    ...document.supplierSkus.map((value) => ({
      score: scoreIdentifier(value, queryNorm) + 20,
      matchedOn: 'supplier-sku' as const,
    })),
    ...document.approvedAliases.map((value) => ({
      score: scoreIdentifier(value, queryNorm) + 15,
      matchedOn: 'approved-alias' as const,
    })),
    {
      score: scoreIdentifier(document.barcodeGtin ?? undefined, queryNorm) + 10,
      matchedOn: 'barcode-gtin' as const,
    },
  ].filter((candidate) => candidate.score > 30);
  return (
    candidates.sort((left, right) => right.score - left.score)[0] ?? {
      score: 0,
      matchedOn: 'none',
    }
  );
}

/**
 * Search canonical product identities while keeping price resolution separate.
 * Description similarity can return an identity candidate, but that hit is
 * deliberately downgraded to identity-only and never carries a price.
 */
export function searchCatalogue(
  records: readonly CatalogueSearchRecord[],
  query: string,
  kinds?: ReadonlySet<ItemKind>,
): CatalogueSearchHit[] {
  const trimmed = query.trim();
  const queryNorm = normalizeIdentifier(trimmed);
  const queryTokens = normalizeDescription(trimmed).split(' ').filter(Boolean);
  const hits: CatalogueSearchHit[] = [];
  for (const record of records) {
    if (kinds && kinds.size > 0 && !kinds.has(record.document.kind)) continue;
    if (trimmed === '') {
      hits.push({ ...record, score: 0, matchedOn: 'none' });
      continue;
    }
    const identifier = bestCatalogueIdentifier(record.document, queryNorm);
    let score = identifier.score;
    let matchedOn = identifier.matchedOn;
    if (score === 0 && record.document.brandName) {
      const brand = normalizeDescription(record.document.brandName);
      const queryDescription = normalizeDescription(trimmed);
      if (brand === queryDescription || brand.includes(queryDescription)) {
        score = brand === queryDescription ? 70 : 65;
        matchedOn = 'brand';
      }
    }
    if (score === 0) {
      const descriptionScore = scoreDescription(record.document.description, trimmed, queryTokens);
      if (descriptionScore > 0) {
        score = descriptionScore;
        matchedOn = 'description';
      }
    }
    if (score === 0) continue;
    hits.push({
      document: record.document,
      score,
      matchedOn,
      price:
        matchedOn === 'description'
          ? {
              kind: 'identity-only',
              explanation:
                'Description similarity found this product identity only. Choose or verify the product identifier before any price is attached.',
            }
          : record.price,
    });
  }
  return hits.sort(
    (left, right) =>
      right.score - left.score || left.document.productId.localeCompare(right.document.productId),
  );
}
