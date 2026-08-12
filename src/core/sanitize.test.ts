import { describe, expect, it } from 'vitest';
import { isFormulaLike, sanitizeFilenamePart, sanitizeForSpreadsheet } from './sanitize';

describe('formula-injection protection', () => {
  it('detects formula-control leading characters', () => {
    expect(isFormulaLike('=SUM(A1:A9)')).toBe(true);
    expect(isFormulaLike('=HYPERLINK("https://example.invalid")')).toBe(true);
    expect(isFormulaLike('@cmd')).toBe(true);
    expect(isFormulaLike('+cmd|/c calc')).toBe(true);
    expect(isFormulaLike('-2+3+cmd')).toBe(true);
    expect(isFormulaLike('\tleading tab')).toBe(true);
    expect(isFormulaLike('\rleading return')).toBe(true);
  });

  it('does not flag ordinary values or plain numbers', () => {
    expect(isFormulaLike('Brass padlock')).toBe(false);
    expect(isFormulaLike('00123')).toBe(false);
    expect(isFormulaLike('-5')).toBe(false);
    expect(isFormulaLike('+2.50')).toBe(false);
    expect(isFormulaLike('')).toBe(false);
  });

  it('neutralises by prefixing an apostrophe and flags the cell', () => {
    expect(sanitizeForSpreadsheet('=1+1')).toEqual({ value: "'=1+1", flagged: true });
    expect(sanitizeForSpreadsheet('safe text')).toEqual({ value: 'safe text', flagged: false });
  });
});

describe('sanitizeFilenamePart', () => {
  it('produces safe lowercase kebab names', () => {
    expect(sanitizeFilenamePart('Acme Locks - Monthly!')).toBe('acme-locks-monthly');
    expect(sanitizeFilenamePart('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeFilenamePart('***')).toBe('unnamed');
    expect(sanitizeFilenamePart('a'.repeat(100))).toHaveLength(40);
  });
});
