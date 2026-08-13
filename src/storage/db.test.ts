import { describe, expect, it } from 'vitest';
import { inspectConfigurationValues } from './db';

const profile = {
  id: 'profile-001',
  name: 'Synthetic supplier',
  version: 1,
  supplierMapping: { supplierCode: 0, supplierCost: 1 },
  supplierHeaders: ['SKU', 'Cost'],
  servicem8Mapping: { itemNumber: 0 },
  servicem8Headers: ['Item Number'],
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
};

const alias = {
  supplierCode: 'SYN-001',
  itemNumber: '000123',
  approvedAt: '2026-08-09T00:00:00.000Z',
};

describe('strict legacy IndexedDB inspection', () => {
  it('reports exact valid counts and adds the safe glass default without discarding records', () => {
    const inspection = inspectConfigurationValues(
      [profile],
      [profile.id],
      [alias],
      [alias.supplierCode],
      { markupPercent: '30', taxHandling: 'prices-inc-gst', theme: 'dark' },
    );

    expect(inspection).toMatchObject({
      legacyConfigurationFound: true,
      valid: true,
      counts: { profiles: 1, aliases: 1, settings: 1 },
      invalidCounts: { profiles: 0, aliases: 0, settings: 0 },
      validationMessages: [],
    });
    expect(inspection.snapshot).toEqual({
      profiles: [profile],
      aliases: [alias],
      settings: {
        markupPercent: '30',
        taxHandling: 'prices-inc-gst',
        theme: 'dark',
        glassTint: 'clear',
      },
    });
  });

  it('blocks malformed values and key conflicts instead of silently filtering or defaulting', () => {
    const inspection = inspectConfigurationValues(
      [
        profile,
        {
          ...profile,
          id: 'profile-bad',
          supplierMapping: { supplierCode: -1 },
        },
      ],
      ['wrong-key', 'profile-bad'],
      [alias, { ...alias, itemNumber: '' }],
      [alias.supplierCode, 'SYN-002'],
      {
        markupPercent: 'not-money',
        taxHandling: 'prices-ex-gst',
        theme: 'dark',
      },
    );

    expect(inspection.valid).toBe(false);
    expect(inspection.counts).toEqual({ profiles: 2, aliases: 2, settings: 1 });
    expect(inspection.invalidCounts).toEqual({
      profiles: 2,
      aliases: 1,
      settings: 1,
    });
    expect(inspection.validationMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('2 legacy mapping profile'),
        expect.stringContaining('1 legacy approved alias'),
        expect.stringContaining('settings record failed validation'),
      ]),
    );
    expect(inspection.snapshot).toBeNull();
  });

  it('blocks unknown legacy fields instead of silently discarding future configuration', () => {
    const rawProfiles = [{ ...profile, unsupportedProfileSetting: true }];
    const rawAliases = [{ ...alias, privateNote: 'synthetic unsupported field' }];
    const rawSettings = {
      markupPercent: '30',
      taxHandling: 'prices-inc-gst',
      theme: 'dark',
      futureTaxSetting: 'retain-me',
    };
    const before = JSON.stringify({ rawProfiles, rawAliases, rawSettings });

    const inspection = inspectConfigurationValues(
      rawProfiles,
      [profile.id],
      rawAliases,
      [alias.supplierCode],
      rawSettings,
    );

    expect(inspection.valid).toBe(false);
    expect(inspection.invalidCounts).toEqual({
      profiles: 1,
      aliases: 1,
      settings: 1,
    });
    expect(inspection.snapshot).toBeNull();
    expect(JSON.stringify({ rawProfiles, rawAliases, rawSettings })).toBe(before);
  });
});
