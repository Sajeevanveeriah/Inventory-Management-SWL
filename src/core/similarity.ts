import { normalizeDescription } from './normalize';

/**
 * Deterministic description similarity for manual-review suggestions only.
 * Sørensen–Dice coefficient over the union of word tokens and character
 * bigrams. Returns a value in [0, 1].
 *
 * A real supplier price list has thousands of unmatched rows and a ServiceM8
 * catalogue has thousands of items, so the naive form — rebuilding both
 * feature sets for every pair — costs tens of millions of set constructions
 * and freezes the interface for minutes. The prepared form below computes each
 * description's features ONCE, interns them as integers, and intersects sorted
 * integer arrays. `similarityBound` additionally rejects pairs that cannot
 * reach a threshold on size alone. Both are exact: the score for any pair is
 * identical to the naive computation, and no pair that could meet a threshold
 * is skipped.
 */

/** A description reduced to its sorted, interned feature identifiers. */
export interface PreparedDescription {
  readonly normalized: string;
  readonly features: Int32Array;
}

/**
 * Interns feature strings as integers so comparison is numeric. One dictionary
 * is shared by every description prepared with it, which is what makes the
 * identifiers comparable.
 */
export class FeatureDictionary {
  private readonly ids = new Map<string, number>();

  private idFor(feature: string): number {
    const existing = this.ids.get(feature);
    if (existing !== undefined) return existing;
    const id = this.ids.size;
    this.ids.set(feature, id);
    return id;
  }

  prepare(text: string): PreparedDescription {
    const normalized = normalizeDescription(text);
    if (normalized === '') {
      return { normalized, features: new Int32Array(0) };
    }
    const seen = new Set<number>();
    for (const word of normalized.split(' ')) {
      if (word !== '') seen.add(this.idFor(`w:${word}`));
    }
    const compact = normalized.replace(/ /g, '');
    for (let i = 0; i < compact.length - 1; i += 1) {
      seen.add(this.idFor(`b:${compact.slice(i, i + 2)}`));
    }
    const features = Int32Array.from(seen);
    features.sort();
    return { normalized, features };
  }
}

/**
 * The highest Dice score two descriptions could possibly reach, judged from
 * their feature counts alone. Overlap can never exceed the smaller set, so
 * this is a true upper bound and rejecting on it never hides a real match.
 */
export function similarityBound(a: PreparedDescription, b: PreparedDescription): number {
  const sizeA = a.features.length;
  const sizeB = b.features.length;
  if (sizeA === 0 || sizeB === 0) return 0;
  return (2 * Math.min(sizeA, sizeB)) / (sizeA + sizeB);
}

/** Dice coefficient of two prepared descriptions. */
export function preparedSimilarity(a: PreparedDescription, b: PreparedDescription): number {
  if (a.normalized === '' || b.normalized === '') return 0;
  if (a.normalized === b.normalized) return 1;
  const left = a.features;
  const right = b.features;
  let i = 0;
  let j = 0;
  let overlap = 0;
  // Both arrays are sorted, so a single merge pass counts the intersection.
  while (i < left.length && j < right.length) {
    const x = left[i] as number;
    const y = right[j] as number;
    if (x === y) {
      overlap += 1;
      i += 1;
      j += 1;
    } else if (x < y) i += 1;
    else j += 1;
  }
  return (2 * overlap) / (left.length + right.length);
}

/**
 * Similarity of two raw descriptions. Convenient for one-off comparisons;
 * bulk comparison should prepare each description once instead.
 */
export function descriptionSimilarity(a: string, b: string): number {
  const dictionary = new FeatureDictionary();
  return preparedSimilarity(dictionary.prepare(a), dictionary.prepare(b));
}

/**
 * Threshold above which an unmatched supplier item is treated as AMBIGUOUS
 * (a same-looking ServiceM8 item exists, so "new item" would be unsafe).
 */
export const AMBIGUITY_THRESHOLD = 0.82;

/** Threshold above which a candidate is worth showing as a suggestion at all. */
export const SUGGESTION_THRESHOLD = 0.55;
