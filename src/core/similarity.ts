import { normalizeDescription } from './normalize';

/**
 * Deterministic description similarity for manual-review suggestions only.
 * Sørensen–Dice coefficient over the union of word tokens and character
 * bigrams. Returns a value in [0, 1].
 */
export function descriptionSimilarity(a: string, b: string): number {
  const na = normalizeDescription(a);
  const nb = normalizeDescription(b);
  if (na === '' || nb === '') return 0;
  if (na === nb) return 1;
  const setA = featureSet(na);
  const setB = featureSet(nb);
  let overlap = 0;
  for (const f of setA) if (setB.has(f)) overlap += 1;
  return (2 * overlap) / (setA.size + setB.size);
}

function featureSet(normalized: string): Set<string> {
  const features = new Set<string>();
  for (const word of normalized.split(' ')) {
    if (word) features.add(`w:${word}`);
  }
  const compact = normalized.replace(/ /g, '');
  for (let i = 0; i < compact.length - 1; i += 1) {
    features.add(`b:${compact.slice(i, i + 2)}`);
  }
  return features;
}

/**
 * Threshold above which an unmatched supplier item is treated as AMBIGUOUS
 * (a same-looking ServiceM8 item exists, so "new item" would be unsafe).
 */
export const AMBIGUITY_THRESHOLD = 0.82;

/** Threshold above which a candidate is worth showing as a suggestion at all. */
export const SUGGESTION_THRESHOLD = 0.55;
