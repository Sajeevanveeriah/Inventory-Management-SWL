import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import Big from 'big.js';
import {
  amountDelta,
  amountEquals,
  applyMarkup,
  formatAmount,
  formatAud,
  markupFormula,
  parseMoney,
} from './money';

describe('parseMoney', () => {
  it('parses plain and formatted AUD amounts', () => {
    expect(parseMoney('100')).toEqual({ ok: true, amount: '100.00', wasRounded: false });
    expect(parseMoney('100.5')).toEqual({ ok: true, amount: '100.50', wasRounded: false });
    expect(parseMoney('1,234.56')).toEqual({ ok: true, amount: '1234.56', wasRounded: false });
    expect(parseMoney('$100.00')).toEqual({ ok: true, amount: '100.00', wasRounded: false });
    expect(parseMoney('AUD 100.00')).toEqual({ ok: true, amount: '100.00', wasRounded: false });
    expect(parseMoney('A$ 42')).toEqual({ ok: true, amount: '42.00', wasRounded: false });
    expect(parseMoney(' 7.25 ')).toEqual({ ok: true, amount: '7.25', wasRounded: false });
  });

  it('rounds >2dp half-up and flags it', () => {
    expect(parseMoney('1.005')).toEqual({ ok: true, amount: '1.01', wasRounded: true });
    expect(parseMoney('2.674')).toEqual({ ok: true, amount: '2.67', wasRounded: true });
    expect(parseMoney('2.675')).toEqual({ ok: true, amount: '2.68', wasRounded: true });
  });

  it('rejects empty, negative and malformed values', () => {
    expect(parseMoney('').ok).toBe(false);
    expect(parseMoney('   ').ok).toBe(false);
    expect(parseMoney('-5').ok).toBe(false);
    expect(parseMoney('(5.00)').ok).toBe(false);
    expect(parseMoney('about $4').ok).toBe(false);
    expect(parseMoney('1.2.3').ok).toBe(false);
    expect(parseMoney('12,34').ok).toBe(true); // comma removed: 1234
    expect(parseMoney('=SUM(A1)').ok).toBe(false);
    expect(parseMoney('N/A').ok).toBe(false);
  });
});

describe('applyMarkup', () => {
  it('confirms the business rule: AUD 100.00 -> AUD 130.00 at 30%', () => {
    expect(applyMarkup('100.00', '30')).toBe('130.00');
  });

  it('rounds half-up to 2 decimal places', () => {
    // 12.35 × 1.30 = 16.055 -> 16.06 (half up)
    expect(applyMarkup('12.35', '30')).toBe('16.06');
    // 0.05 × 1.30 = 0.065 -> 0.07
    expect(applyMarkup('0.05', '30')).toBe('0.07');
    expect(applyMarkup('0.00', '30')).toBe('0.00');
  });

  it('is decimal-safe where binary floats are not', () => {
    // 0.1 + 0.2 style traps: 19.90 × 1.30 = 25.87 exactly
    expect(applyMarkup('19.90', '30')).toBe('25.87');
    expect(applyMarkup('0.10', '30')).toBe('0.13');
  });

  it('supports non-default markups', () => {
    expect(applyMarkup('100.00', '0')).toBe('100.00');
    expect(applyMarkup('100.00', '12.5')).toBe('112.50');
  });

  it('property: result equals Big-computed cost × factor for any cents value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (cents) => {
        const cost = new Big(cents).div(100).toFixed(2);
        const expected = new Big(cost).times('1.3').round(2, Big.roundHalfUp).toFixed(2);
        expect(applyMarkup(cost, '30')).toBe(expected);
      }),
    );
  });

  it('property: parseMoney round-trips canonical amounts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (cents) => {
        const amount = new Big(cents).div(100).toFixed(2);
        const parsed = parseMoney(amount);
        expect(parsed).toEqual({ ok: true, amount, wasRounded: false });
      }),
    );
  });
});

describe('amount helpers', () => {
  it('compares and subtracts exactly', () => {
    expect(amountEquals('12.50', '12.50')).toBe(true);
    expect(amountEquals('12.50', '12.51')).toBe(false);
    expect(amountDelta('45.00', '48.00')).toBe('3.00');
    expect(amountDelta('2.10', '1.80')).toBe('-0.30');
  });

  it('formats amounts for display', () => {
    expect(formatAmount('1234.50')).toBe('$1,234.50');
    expect(formatAmount('0.05')).toBe('$0.05');
    expect(formatAud('130.00')).toBe('AUD 130.00');
  });

  it('shows the formula with the calculated result', () => {
    expect(markupFormula('100.00', '30')).toBe('$100.00 × 1.3 = $130.00');
  });
});
