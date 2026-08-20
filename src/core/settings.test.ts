import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTING_DEFINITIONS,
  SETTING_DEFINITION_LIST,
  SettingsSchema,
} from './settings';

describe('authoritative setting definitions', () => {
  it('defines exactly the strict runtime settings schema', () => {
    expect(Object.keys(SETTING_DEFINITIONS).sort()).toEqual(
      Object.keys(SettingsSchema.shape).sort(),
    );
    expect(SETTING_DEFINITION_LIST.map((definition) => definition.key).sort()).toEqual([
      'glassTint',
      'markupPercent',
      'taxHandling',
      'theme',
    ]);
  });

  it('derives valid defaults from the same definitions', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      markupPercent: '30',
      taxHandling: 'not-configured',
      theme: 'system',
      glassTint: 'clear',
    });
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it('migrates the former three-field settings shape without accepting drift', () => {
    expect(
      SettingsSchema.parse({
        markupPercent: '30',
        taxHandling: 'prices-inc-gst',
        theme: 'system',
      }),
    ).toEqual({
      markupPercent: '30',
      taxHandling: 'prices-inc-gst',
      theme: 'system',
      glassTint: 'clear',
    });
    expect(
      SettingsSchema.safeParse({
        ...DEFAULT_SETTINGS,
        phantomSetting: true,
      }).success,
    ).toBe(false);
  });
});
