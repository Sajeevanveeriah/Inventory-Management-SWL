import { describe, expect, it } from 'vitest';
import { SERVICEM8_FIELDS, SUPPLIER_FIELDS, fieldsForRole } from './fields';
import { SERVICEM8_MAPPING_KEYS, SUPPLIER_MAPPING_KEYS } from '../platform/schemas';

/**
 * The persistence layer validates a saved mapping profile against an explicit
 * allowlist of field keys. If a field exists in the mapping UI but not in that
 * allowlist, every profile that uses it silently fails validation and cannot be
 * saved at all - which is exactly the failure this test exists to prevent.
 * The two lists are kept separate deliberately: a validation boundary should be
 * stated, not inferred, so widening it is always a visible decision.
 */
describe('field definitions and the persistence allowlist', () => {
  it('covers every supplier field', () => {
    expect([...SUPPLIER_MAPPING_KEYS].sort()).toEqual(
      SUPPLIER_FIELDS.map((field) => field.key).sort(),
    );
  });

  it('covers every ServiceM8 field', () => {
    expect([...SERVICEM8_MAPPING_KEYS].sort()).toEqual(
      SERVICEM8_FIELDS.map((field) => field.key).sort(),
    );
  });

  it('marks the fields a correct price depends on as required', () => {
    const required = SERVICEM8_FIELDS.filter((field) => field.required).map((f) => f.key);
    // Item Number keys the import, Name identifies it, Price is what the run
    // compares against and replaces, and the tax basis decides whether GST is
    // added - guessing any of them would produce a wrong price silently.
    expect(required.sort()).toEqual(
      ['existingSellPrice', 'itemDescription', 'itemNumber', 'priceIncludesTaxes'].sort(),
    );
  });

  it('does not require a purchase cost, which real exports leave at zero', () => {
    const cost = SERVICEM8_FIELDS.find((field) => field.key === 'existingCost');
    expect(cost?.required).toBe(false);
  });

  it('returns the right definitions for each file role', () => {
    expect(fieldsForRole('supplier')).toBe(SUPPLIER_FIELDS);
    expect(fieldsForRole('servicem8')).toBe(SERVICEM8_FIELDS);
  });
});
