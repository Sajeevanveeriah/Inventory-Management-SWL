import { describe, expect, it } from 'vitest';
import { normalizeDescription, normalizeIdentifier } from './normalize';

describe('normalizeIdentifier', () => {
  it('trims and uppercases only', () => {
    expect(normalizeIdentifier('  abc-123 ')).toBe('ABC-123');
  });

  it('preserves leading zeroes', () => {
    expect(normalizeIdentifier('00123')).toBe('00123');
    expect(normalizeIdentifier(' 00123 ')).toBe('00123');
  });

  it('preserves punctuation and internal spacing', () => {
    expect(normalizeIdentifier('AB/12.3-X_9')).toBe('AB/12.3-X_9');
    expect(normalizeIdentifier('AB  12')).toBe('AB  12');
    expect(normalizeIdentifier('#001')).toBe('#001');
  });
});

describe('normalizeDescription', () => {
  it('lowercases, collapses whitespace and strips punctuation for similarity only', () => {
    expect(normalizeDescription('  Brass  Padlock, 40mm! ')).toBe('brass padlock 40mm');
  });
});
