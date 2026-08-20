import { describe, expect, it } from 'vitest';
import { resolveSupplierOffer, supplierOfferIdentityKey, type SupplierOffer } from './offers';

const asOf = '2026-08-20T00:00:00Z';
function offer(overrides: Partial<SupplierOffer> = {}): SupplierOffer {
  return {
    id: 'offer-a',
    productId: 'product-a',
    supplierId: 'supplier-a',
    supplierSku: 'SKU-A',
    costAmount: '100.00',
    costBasis: 'excluding-gst',
    currency: 'AUD',
    active: true,
    preferred: false,
    observedAt: '2026-08-19T00:00:00Z',
    validUntil: '2026-09-01T00:00:00Z',
    provenance: {
      sourceSystem: 'supplier-file',
      sourceRecordId: 'row-a',
      evidenceKind: 'supplier-offer',
      observedAt: '2026-08-19T00:00:00Z',
      description: 'Supplier offer row',
    },
    ...overrides,
  };
}

describe('resolveSupplierOffer', () => {
  it('uses an explicit valid selection before every automatic rule', () => {
    const selected = offer({ id: 'selected', costAmount: '200.00' });
    const cheaperPreferred = offer({ id: 'cheap', costAmount: '1.00', preferred: true });
    expect(
      resolveSupplierOffer({
        productId: 'product-a',
        offers: [selected, cheaperPreferred],
        selectedOfferId: 'selected',
        asOf,
      }),
    ).toMatchObject({ ok: true, method: 'explicit', offer: { id: 'selected' } });
  });

  it('rejects a cross-product explicit selection', () => {
    expect(
      resolveSupplierOffer({
        productId: 'product-a',
        offers: [offer({ id: 'other', productId: 'product-b' })],
        selectedOfferId: 'other',
        asOf,
      }),
    ).toMatchObject({ ok: false, reason: 'selection-product-mismatch' });
  });

  it.each([
    [offer({ active: false }), 'selected-offer-inactive'],
    [offer({ validUntil: '2026-08-19T23:59:59Z' }), 'selected-offer-stale'],
    [offer({ effectiveAt: '2026-08-20T00:00:01Z' }), 'selected-offer-stale'],
    [offer({ effectiveAt: 'not-a-date' }), 'selected-offer-stale'],
  ] as const)('blocks an explicitly selected unusable offer', (selected, reason) => {
    expect(
      resolveSupplierOffer({
        productId: 'product-a',
        offers: [selected],
        selectedOfferId: selected.id,
        asOf,
      }),
    ).toMatchObject({ ok: false, reason });
  });

  it('uses exactly one valid preferred offer', () => {
    expect(
      resolveSupplierOffer({
        productId: 'product-a',
        offers: [offer({ id: 'normal' }), offer({ id: 'preferred', preferred: true })],
        asOf,
      }),
    ).toMatchObject({ ok: true, method: 'preferred', offer: { id: 'preferred' } });
  });

  it('blocks multiple preferred offers', () => {
    expect(
      resolveSupplierOffer({
        productId: 'product-a',
        offers: [offer({ id: 'p1', preferred: true }), offer({ id: 'p2', preferred: true })],
        asOf,
      }),
    ).toMatchObject({ ok: false, reason: 'multiple-preferred-offers' });
  });

  it('uses the sole valid offer after excluding inactive and stale offers', () => {
    expect(
      resolveSupplierOffer({
        productId: 'product-a',
        offers: [
          offer({ id: 'valid' }),
          offer({ id: 'inactive', active: false }),
          offer({ id: 'stale', validUntil: '2026-01-01T00:00:00Z' }),
          offer({ id: 'future', effectiveAt: '2026-08-21T00:00:00Z' }),
        ],
        asOf,
      }),
    ).toMatchObject({ ok: true, method: 'sole-valid', offer: { id: 'valid' } });
  });

  it('blocks ambiguous offers rather than silently choosing the cheapest', () => {
    const result = resolveSupplierOffer({
      productId: 'product-a',
      offers: [
        offer({ id: 'expensive', costAmount: '200.00' }),
        offer({ id: 'cheap', costAmount: '1.00' }),
      ],
      asOf,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: 'ambiguous-offers',
      candidateOfferIds: ['expensive', 'cheap'],
    });
  });

  it('blocks when no active current offers remain', () => {
    expect(
      resolveSupplierOffer({
        productId: 'product-a',
        offers: [offer({ active: false })],
        asOf,
      }),
    ).toMatchObject({ ok: false, reason: 'no-valid-offers' });
  });
});

describe('supplierOfferIdentityKey', () => {
  it('is stable for product, supplier and supplier SKU without delimiter collisions', () => {
    expect(supplierOfferIdentityKey(offer())).toBe('["product-a","supplier-a","SKU-A"]');
    expect(
      supplierOfferIdentityKey(offer({ productId: 'product-a|supplier-a', supplierId: '' })),
    ).not.toBe(supplierOfferIdentityKey(offer()));
  });
});
