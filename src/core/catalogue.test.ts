import { describe, expect, it } from 'vitest';
import {
  CATALOGUE_ITEM_KINDS,
  catalogueKindLabel,
  createPriceProvenance,
  isStockTrackedKind,
} from './catalogue';

describe('catalogue item kinds', () => {
  it('represents physical products, services and labour distinctly', () => {
    expect(CATALOGUE_ITEM_KINDS).toEqual(['physical-product', 'service', 'labour']);
    expect(CATALOGUE_ITEM_KINDS.map(catalogueKindLabel)).toEqual([
      'Physical product',
      'Service',
      'Labour',
    ]);
  });

  it('tracks stock only for physical products', () => {
    expect(isStockTrackedKind('physical-product')).toBe(true);
    expect(isStockTrackedKind('service')).toBe(false);
    expect(isStockTrackedKind('labour')).toBe(false);
  });
});

describe('price provenance', () => {
  it('preserves typed source facts and trims display text', () => {
    expect(
      createPriceProvenance({
        sourceSystem: ' supplier-file ',
        sourceRecordId: ' row-42 ',
        evidenceKind: 'supplier-import',
        observedAt: '2026-08-20T00:00:00Z',
        description: ' imported unit cost ',
      }),
    ).toMatchObject({
      sourceSystem: 'supplier-file',
      sourceRecordId: 'row-42',
      description: 'imported unit cost',
    });
  });

  it('rejects blank and unbounded provenance text', () => {
    const base = {
      sourceSystem: 'supplier-file',
      sourceRecordId: 'row-42',
      evidenceKind: 'supplier-import' as const,
      observedAt: '2026-08-20T00:00:00Z',
      description: 'cost',
    };
    expect(() => createPriceProvenance({ ...base, sourceRecordId: ' ' })).toThrow(
      'sourceRecordId must not be blank',
    );
    expect(() => createPriceProvenance({ ...base, description: 'x'.repeat(241) })).toThrow(
      'description exceeds 240 characters',
    );
  });
});
