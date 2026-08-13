import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../core/settings';
import { defaultSources } from '../core/sources';
import type { GeneratedOutput } from '../io/exportWorkbooks';
import { INITIAL_STATE, reducer, resolveAppearanceTheme } from './store';

const syntheticOutput: GeneratedOutput = {
  filename: '20260809-Synthetic-Audit.txt',
  label: 'Synthetic audit',
  kind: 'audit',
  blob: new Blob(['synthetic']),
  sanitizedCells: 0,
};

describe('workflow invalidation guards', () => {
  it('rejects an asynchronous output generated before a persisted business-rule change', () => {
    const generatingState = {
      ...INITIAL_STATE,
      configurationHydration: {
        status: 'ready' as const,
        error: null,
        attempt: 0,
      },
      outputRevision: 7,
    };
    const changed = reducer(generatingState, {
      type: 'settings-changed',
      settings: { ...DEFAULT_SETTINGS, markupPercent: '35' },
      description: 'synthetic persisted markup change',
      businessRule: true,
    });

    expect(changed.outputRevision).toBe(8);
    const staleCompletion = reducer(changed, {
      type: 'outputs-ready',
      outputs: [syntheticOutput],
      expectedRevision: 7,
    });
    expect(staleCompletion.outputs).toBeNull();

    const currentCompletion = reducer(changed, {
      type: 'outputs-ready',
      outputs: [syntheticOutput],
      expectedRevision: 8,
    });
    expect(currentCompletion.outputs).toEqual([syntheticOutput]);
    expect(currentCompletion.announcement).toBe('1 output file generated and ready to save.');
  });

  it('invalidates generated output on input replacement, alias changes and configuration reload', () => {
    const stateWithOutput = {
      ...INITIAL_STATE,
      outputs: [syntheticOutput],
      outputRevision: 10,
    };
    const loading = reducer(stateWithOutput, {
      type: 'file-loading',
      role: 'supplier',
    });
    expect(loading.outputs).toBeNull();
    expect(loading.outputRevision).toBe(11);

    const aliased = reducer(stateWithOutput, {
      type: 'alias-approved',
      alias: {
        supplierCode: 'SYN-001',
        itemNumber: '000123',
        approvedAt: '2026-08-09T00:00:00.000Z',
      },
      persisted: true,
    });
    expect(aliased.outputs).toBeNull();
    expect(aliased.outputRevision).toBe(11);

    const hydrated = reducer(stateWithOutput, {
      type: 'configuration-hydration-succeeded',
      settings: { ...DEFAULT_SETTINGS, markupPercent: '40' },
      profiles: [],
      aliases: [],
      sources: defaultSources(),
    });
    expect(hydrated.outputs).toBeNull();
    expect(hydrated.outputRevision).toBe(11);
  });
});

describe('appearance resolution', () => {
  it('uses the operating-system preference only in system mode', () => {
    expect(resolveAppearanceTheme('system', false)).toBe('light');
    expect(resolveAppearanceTheme('system', true)).toBe('dark');
    expect(resolveAppearanceTheme('light', true)).toBe('light');
    expect(resolveAppearanceTheme('dark', false)).toBe('dark');
  });
});
