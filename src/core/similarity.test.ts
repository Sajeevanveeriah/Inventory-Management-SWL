import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { normalizeDescription } from './normalize';
import {
  AMBIGUITY_THRESHOLD,
  FeatureDictionary,
  SUGGESTION_THRESHOLD,
  descriptionSimilarity,
  preparedSimilarity,
  similarityBound,
} from './similarity';

/** The original definition, kept here as the reference the fast path must match. */
function naiveSimilarity(a: string, b: string): number {
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

const TEXT = fc.string({ minLength: 0, maxLength: 60 });

describe('similarity', () => {
  it('scores identical and unrelated descriptions predictably', () => {
    expect(descriptionSimilarity('Brass Padlock 40mm', 'Brass Padlock 40mm')).toBe(1);
    expect(descriptionSimilarity('', 'anything')).toBe(0);
    expect(descriptionSimilarity('Brass Padlock 40mm', 'Digital Door Closer')).toBeLessThan(
      SUGGESTION_THRESHOLD,
    );
  });

  it('ignores punctuation and case, as documented', () => {
    expect(descriptionSimilarity('BRASS PADLOCK, 40MM.', 'brass padlock 40mm')).toBe(1);
  });

  it('produces exactly the same score as the reference definition', () => {
    fc.assert(
      fc.property(TEXT, TEXT, (a, b) => {
        expect(descriptionSimilarity(a, b)).toBeCloseTo(naiveSimilarity(a, b), 12);
      }),
      { numRuns: 1000 },
    );
  });

  it('never rejects a pair that could have met a threshold', () => {
    // The bound is what lets the engine skip work; if it were ever below the
    // real score, a genuine near-duplicate could slip through as a new item.
    fc.assert(
      fc.property(TEXT, TEXT, (a, b) => {
        const dictionary = new FeatureDictionary();
        const left = dictionary.prepare(a);
        const right = dictionary.prepare(b);
        expect(similarityBound(left, right)).toBeGreaterThanOrEqual(
          preparedSimilarity(left, right) - 1e-12,
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('keeps the ambiguity threshold above the suggestion threshold', () => {
    expect(AMBIGUITY_THRESHOLD).toBeGreaterThan(SUGGESTION_THRESHOLD);
  });

  it('shares feature identifiers across descriptions prepared together', () => {
    const dictionary = new FeatureDictionary();
    const a = dictionary.prepare('Brass Padlock 40mm');
    const b = dictionary.prepare('Brass Padlock 50mm');
    expect(preparedSimilarity(a, b)).toBeGreaterThan(SUGGESTION_THRESHOLD);
    expect(preparedSimilarity(a, b)).toBeLessThan(1);
  });
});
