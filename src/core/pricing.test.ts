import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import Big from 'big.js';
import { basisFromIncludesTaxes, costBasisFromTaxHandling, derivePrice } from './pricing';
import { addGst, removeGst } from './money';

describe('derivePrice', () => {
  it('marks up a GST-exclusive cost and leaves a GST-exclusive target alone', () => {
    const result = derivePrice({
      costAmount: '48.00',
      costBasis: 'excluding-gst',
      markupPercent: '30',
      targetBasis: 'excluding-gst',
    });
    expect(result.costExGst).toBe('48.00');
    expect(result.sellExGst).toBe('62.40');
    expect(result.price).toBe('62.40');
    expect(result.purchaseCost).toBe('48.00');
  });

  it('adds GST when the target ServiceM8 row stores a tax-inclusive price', () => {
    const result = derivePrice({
      costAmount: '48.00',
      costBasis: 'excluding-gst',
      markupPercent: '30',
      targetBasis: 'including-gst',
    });
    expect(result.sellExGst).toBe('62.40');
    expect(result.sellIncGst).toBe('68.64');
    expect(result.price).toBe('68.64');
    // The cost column always records the GST-exclusive cost.
    expect(result.purchaseCost).toBe('48.00');
  });

  it('removes GST from a tax-inclusive supplier cost before marking up', () => {
    const result = derivePrice({
      costAmount: '110.00',
      costBasis: 'including-gst',
      markupPercent: '30',
      targetBasis: 'excluding-gst',
    });
    expect(result.costExGst).toBe('100.00');
    expect(result.price).toBe('130.00');
  });

  it('never marks up the tax component', () => {
    const inclusive = derivePrice({
      costAmount: '110.00',
      costBasis: 'including-gst',
      markupPercent: '30',
      targetBasis: 'including-gst',
    });
    // 110 inc -> 100 ex -> 130 ex -> 143 inc. Marking up the inclusive figure
    // would give 143.00 too here, but only because 1.3 and 1.1 commute; the
    // cost column proves the tax was excluded from the markup base.
    expect(inclusive.costExGst).toBe('100.00');
    expect(inclusive.sellExGst).toBe('130.00');
    expect(inclusive.price).toBe('143.00');
  });

  it('rounds half up to two decimals', () => {
    const result = derivePrice({
      costAmount: '7.25',
      costBasis: 'excluding-gst',
      markupPercent: '30',
      targetBasis: 'excluding-gst',
    });
    // 7.25 x 1.3 = 9.425 -> 9.43
    expect(result.price).toBe('9.43');
  });

  it('explains the derivation in the operator’s terms', () => {
    const result = derivePrice({
      costAmount: '1.80',
      costBasis: 'excluding-gst',
      markupPercent: '30',
      targetBasis: 'including-gst',
    });
    expect(result.price).toBe('2.57');
    expect(result.explanation).toContain('$1.80 × 1.3 (30% on cost) = $2.34 ex GST');
    expect(result.explanation).toContain('$2.34 × 1.1 (10% GST) = $2.57 incl GST');
  });

  it('honours a non-default GST rate', () => {
    const result = derivePrice({
      costAmount: '100.00',
      costBasis: 'excluding-gst',
      markupPercent: '30',
      targetBasis: 'including-gst',
      gstRatePercent: '15',
    });
    expect(result.price).toBe('149.50');
  });

  it('is the ONLY difference between the two target bases', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5_000_00 }), (cents) => {
        const cost = new Big(cents).div(100).toFixed(2);
        const ex = derivePrice({
          costAmount: cost,
          costBasis: 'excluding-gst',
          markupPercent: '30',
          targetBasis: 'excluding-gst',
        });
        const inc = derivePrice({
          costAmount: cost,
          costBasis: 'excluding-gst',
          markupPercent: '30',
          targetBasis: 'including-gst',
        });
        expect(inc.sellExGst).toBe(ex.sellExGst);
        expect(inc.price).toBe(addGst(ex.sellExGst, '10'));
      }),
      { numRuns: 300 },
    );
  });
});

describe('GST helpers', () => {
  it('adds and removes GST at the Australian rate', () => {
    expect(addGst('100.00', '10')).toBe('110.00');
    expect(removeGst('110.00', '10')).toBe('100.00');
  });

  it('rounds a divided amount half up', () => {
    // 2.73 / 1.1 = 2.4818... -> 2.48
    expect(removeGst('2.73', '10')).toBe('2.48');
  });
});

describe('basis mapping', () => {
  it('maps the ServiceM8 flag to a basis', () => {
    expect(basisFromIncludesTaxes(true)).toBe('including-gst');
    expect(basisFromIncludesTaxes(false)).toBe('excluding-gst');
  });

  it('refuses to assume a supplier basis that was never confirmed', () => {
    expect(costBasisFromTaxHandling('not-configured')).toBeNull();
    expect(costBasisFromTaxHandling('prices-ex-gst')).toBe('excluding-gst');
    expect(costBasisFromTaxHandling('prices-inc-gst')).toBe('including-gst');
  });
});
