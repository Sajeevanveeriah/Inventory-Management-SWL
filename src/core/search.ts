import type { ComparisonRow } from './compare';
import type { BaseStatus } from './statuses';
import { normalizeDescription, normalizeIdentifier } from './normalize';
import { descriptionSimilarity } from './similarity';

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

function tokens(query: string): string[] {
  return normalizeDescription(query).split(' ').filter(Boolean);
}

function scoreIdentifier(identifier: string | undefined, queryNorm: string): number {
  if (!identifier || queryNorm === '') return 0;
  const idNorm = normalizeIdentifier(identifier);
  if (idNorm === queryNorm) return 100;
  if (idNorm.startsWith(queryNorm)) return 90;
  if (idNorm.includes(queryNorm)) return 75;
  return 0;
}

function scoreDescription(description: string | undefined, query: string): number {
  if (!description) return 0;
  const queryTokens = tokens(query);
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
    const descScore = Math.max(
      scoreDescription(row.supplier?.description, trimmed),
      scoreDescription(row.s8?.description, trimmed),
    );
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
