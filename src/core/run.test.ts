import { describe, expect, it } from 'vitest';
import { newRunId, outputFilename } from './run';

describe('newRunId', () => {
  it('produces 6-character identifiers from a safe alphabet', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(newRunId()).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ0-9]{6}$/);
    }
  });
});

describe('outputFilename', () => {
  it('builds deterministic sanitised names with date, profile, purpose and run id', () => {
    const name = outputFilename(
      new Date(2026, 7, 3),
      'Acme Locks — Monthly!',
      'import-candidate',
      'AB12CD',
      'xlsx',
    );
    expect(name).toBe('2026-08-03_acme-locks-monthly_import-candidate_run-AB12CD.xlsx');
  });
});
