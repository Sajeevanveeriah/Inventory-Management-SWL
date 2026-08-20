import { describe, expect, it } from 'vitest';
import { evaluateMarkupFloor, resolveMarkupRule, resolvePriceRule } from './pricingRules';

describe('resolveMarkupRule', () => {
  it.each([
    [{ globalMarkupPercent: '30' }, 'global', '30'],
    [{ globalMarkupPercent: '30', brandMarkupPercent: '35' }, 'brand', '35'],
    [
      { globalMarkupPercent: '30', brandMarkupPercent: '35', productMarkupPercent: '42' },
      'product',
      '42',
    ],
    [
      { globalMarkupPercent: '30', brandMarkupPercent: null, productMarkupPercent: undefined },
      'global',
      '30',
    ],
    [
      { globalMarkupPercent: '30', brandMarkupPercent: '35', productMarkupPercent: null },
      'brand',
      '35',
    ],
  ] as const)('uses exact product > brand > global precedence', (input, level, value) => {
    expect(resolveMarkupRule(input)).toMatchObject({ level, markupPercent: value });
  });

  it('preserves numeric zero as an explicit product rule', () => {
    expect(
      resolveMarkupRule({
        globalMarkupPercent: '30',
        brandMarkupPercent: '35',
        productMarkupPercent: 0,
      }),
    ).toMatchObject({ level: 'product', markupPercent: '0' });
  });

  it('preserves string zero as an explicit brand rule', () => {
    expect(resolveMarkupRule({ globalMarkupPercent: '30', brandMarkupPercent: '0' })).toMatchObject(
      { level: 'brand', markupPercent: '0' },
    );
  });
});

describe('evaluateMarkupFloor', () => {
  it('reports a blocking result separately from rule resolution', () => {
    expect(evaluateMarkupFloor('100.00', '100.00')).toEqual({
      blocked: true,
      minimumMarkupPercent: '30',
      minimumSellExGst: '130.00',
      proposedSellExGst: '100.00',
      explanation: 'Blocked: 100.00 ex GST is below the 30% markup floor of 130.00 ex GST',
    });
  });

  it('accepts the exact floor and values above it', () => {
    expect(evaluateMarkupFloor('100.00', '130.00').blocked).toBe(false);
    expect(evaluateMarkupFloor('100.00', '130.01').blocked).toBe(false);
  });
});

describe('resolvePriceRule', () => {
  it('returns a discriminated blocked resolution while retaining its explicit source', () => {
    expect(
      resolvePriceRule('100.00', {
        globalMarkupPercent: '30',
        brandMarkupPercent: '35',
        productMarkupPercent: '0',
      }),
    ).toMatchObject({
      ok: false,
      reason: 'below-minimum-markup',
      markup: { level: 'product', markupPercent: '0' },
      sellExGst: '100.00',
    });
  });

  it('returns an allowed resolution at the floor', () => {
    expect(resolvePriceRule('100.00', { globalMarkupPercent: '30' })).toMatchObject({
      ok: true,
      markup: { level: 'global' },
      sellExGst: '130.00',
    });
  });
});
