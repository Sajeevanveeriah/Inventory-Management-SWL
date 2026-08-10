import { describe, expect, it } from 'vitest';
import { datePrefix, newRunId, outputFilename } from './run';

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
      'servicem8-import',
      'AB12CD',
      'csv',
    );
    expect(name).toBe('20260803-acme-locks-monthly_servicem8-import_run-AB12CD.csv');
  });
});

describe('datePrefix', () => {
  it('uses local calendar fields rather than a UTC ISO date', () => {
    const localBoundary = {
      getFullYear: () => 2026,
      getMonth: () => 7,
      getDate: () => 10,
      toISOString: () => '2026-08-09T14:30:00.000Z',
    } as Date;
    expect(datePrefix(localBoundary)).toBe('20260810');
  });
});
