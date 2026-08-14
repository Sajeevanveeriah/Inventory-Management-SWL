import { describe, expect, it } from 'vitest';
import { SUPPLIER_FIELDS } from './fields';
import { suggestMappings, validateMapping } from './mapping';

describe('suggestMappings', () => {
  it('suggests likely columns from headers without auto-applying anything', () => {
    const suggestions = suggestMappings(
      ['Product Code', 'Product Name', 'Trade Price'],
      SUPPLIER_FIELDS,
    );
    const byField = Object.fromEntries(suggestions.map((s) => [s.field, s.columnIndex]));
    expect(byField.supplierCode).toBe(0);
    expect(byField.supplierDescription).toBe(1);
    expect(byField.supplierCost).toBe(2);
    for (const s of suggestions) {
      expect(s.reason).toBeTruthy();
      expect(['high', 'medium']).toContain(s.confidence);
    }
  });

  it('suggests the optional supplier category without making it required', () => {
    const suggestions = suggestMappings(
      ['Product Code', 'Description', 'Item Price', 'Category'],
      SUPPLIER_FIELDS,
    );
    const byField = Object.fromEntries(suggestions.map((s) => [s.field, s.columnIndex]));
    expect(byField.supplierCategory).toBe(3);
    expect(
      validateMapping(
        { supplierCode: 0, supplierDescription: 1, supplierCost: 2 },
        SUPPLIER_FIELDS,
        ['Product Code', 'Description', 'Item Price'],
      ),
    ).toHaveLength(0);
  });

  it('never assigns the same column to two fields', () => {
    const suggestions = suggestMappings(['Code', 'Misc'], SUPPLIER_FIELDS);
    const cols = suggestions.map((s) => s.columnIndex);
    expect(new Set(cols).size).toBe(cols.length);
  });

  it('returns nothing for unrecognisable headers', () => {
    expect(suggestMappings(['Alpha', 'Beta', 'Gamma'], SUPPLIER_FIELDS)).toHaveLength(0);
  });
});

describe('validateMapping', () => {
  const headers = ['Code', 'Name', 'Cost'];

  it('accepts a complete valid mapping', () => {
    const issues = validateMapping(
      { supplierCode: 0, supplierDescription: 1, supplierCost: 2 },
      SUPPLIER_FIELDS,
      headers,
    );
    expect(issues).toHaveLength(0);
  });

  it('reports every missing required field', () => {
    const issues = validateMapping({}, SUPPLIER_FIELDS, headers);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(3);
  });

  it('detects the same column mapped to two fields', () => {
    const issues = validateMapping(
      { supplierCode: 0, supplierDescription: 0, supplierCost: 2 },
      SUPPLIER_FIELDS,
      headers,
    );
    expect(issues.some((i) => i.message.includes('more than one field'))).toBe(true);
  });

  it('detects mappings to columns that no longer exist', () => {
    const issues = validateMapping(
      { supplierCode: 9, supplierDescription: 1, supplierCost: 2 },
      SUPPLIER_FIELDS,
      headers,
    );
    expect(issues.some((i) => i.message.includes('no longer exists'))).toBe(true);
  });
});
