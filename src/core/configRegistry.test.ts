import { describe, expect, it } from 'vitest';
import { SETTING_REGISTRY, defaultConfig, resolveConfigValue, validateConfigImport } from './configRegistry';

describe('configuration registry', () => {
  it('contains required defaults and locked invariants', () => {
    const config = defaultConfig();
    expect(config['pricing.markupPercent']).toBe(30);
    expect(config['pricing.costFloorPercent']).toBe(30);
    expect(config['competitor.noLiveFetch']).toBe(true);
    expect(config['output.formulaInjectionProtection']).toBe(true);
    expect(config['privacy.persistRawRowsByDefault']).toBe(false);
  });

  it('rejects unknown settings and unsafe locked overrides', () => {
    expect(validateConfigImport({ 'privacy.cloudPersistence': true, 'unknown.value': 1 })).toEqual([
      'privacy.cloudPersistence: locked invariant cannot be changed',
      'unknown.value: unknown setting',
    ]);
  });

  it('validates ranges and resolves scope precedence', () => {
    expect(validateConfigImport({ 'pricing.markupPercent': 999 })).toEqual([
      'pricing.markupPercent: outside allowed range',
    ]);
    expect(resolveConfigValue('pricing.markupPercent', { global: { 'pricing.markupPercent': 30 }, supplier: { 'pricing.markupPercent': 35 }, run: { 'pricing.markupPercent': 32 } })).toEqual({ value: 32, source: 'run' });
  });

  it('has documentation metadata for every setting', () => {
    expect(SETTING_REGISTRY.every((setting) => setting.helpText && setting.category && setting.schemaVersion === 1)).toBe(true);
  });
});
