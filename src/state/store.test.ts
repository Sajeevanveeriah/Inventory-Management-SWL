import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../core/settings';
import { defaultSources } from '../core/sources';
import type { GeneratedOutput } from '../io/exportWorkbooks';
import {
  buildCatalogueSearchRecords,
  INITIAL_STATE,
  reducer,
  resolveAppearanceTheme,
} from './store';

const syntheticOutput: GeneratedOutput = {
  filename: '20260809-Synthetic-Audit.txt',
  label: 'Synthetic audit',
  kind: 'audit',
  blob: new Blob(['synthetic']),
  sanitizedCells: 0,
};

describe('workflow invalidation guards', () => {
  it('rejects an asynchronous output generated before a persisted business-rule change', () => {
    const generatingState = {
      ...INITIAL_STATE,
      configurationHydration: {
        status: 'ready' as const,
        error: null,
        attempt: 0,
      },
      outputRevision: 7,
    };
    const changed = reducer(generatingState, {
      type: 'settings-changed',
      settings: { ...DEFAULT_SETTINGS, markupPercent: '35' },
      description: 'synthetic persisted markup change',
      businessRule: true,
    });

    expect(changed.outputRevision).toBe(8);
    const staleCompletion = reducer(changed, {
      type: 'outputs-ready',
      outputs: [syntheticOutput],
      expectedRevision: 7,
    });
    expect(staleCompletion.outputs).toBeNull();

    const currentCompletion = reducer(changed, {
      type: 'outputs-ready',
      outputs: [syntheticOutput],
      expectedRevision: 8,
    });
    expect(currentCompletion.outputs).toEqual([syntheticOutput]);
    expect(currentCompletion.announcement).toBe('1 output file generated and ready to save.');
  });

  it('invalidates generated output on input replacement, alias changes and configuration reload', () => {
    const stateWithOutput = {
      ...INITIAL_STATE,
      outputs: [syntheticOutput],
      outputRevision: 10,
    };
    const loading = reducer(stateWithOutput, {
      type: 'file-loading',
      role: 'supplier',
    });
    expect(loading.outputs).toBeNull();
    expect(loading.outputRevision).toBe(11);

    const aliased = reducer(stateWithOutput, {
      type: 'alias-approved',
      alias: {
        supplierCode: 'SYN-001',
        itemNumber: '000123',
        approvedAt: '2026-08-09T00:00:00.000Z',
      },
      persisted: true,
    });
    expect(aliased.outputs).toBeNull();
    expect(aliased.outputRevision).toBe(11);

    const hydrated = reducer(stateWithOutput, {
      type: 'configuration-hydration-succeeded',
      settings: { ...DEFAULT_SETTINGS, markupPercent: '40' },
      profiles: [],
      aliases: [],
      sources: defaultSources(),
      catalogueItems: [],
      brands: [],
      catalogueSuppliers: [],
      supplierOffers: [],
      offerSelections: [],
      settingsAudit: [],
      syncRuns: [],
      syncCheckpoints: [],
      syncItemOutcomes: [],
    });
    expect(hydrated.outputs).toBeNull();
    expect(hydrated.outputRevision).toBe(11);
  });
});

describe('appearance resolution', () => {
  it('uses the operating-system preference only in system mode', () => {
    expect(resolveAppearanceTheme('system', false)).toBe('light');
    expect(resolveAppearanceTheme('system', true)).toBe('dark');
    expect(resolveAppearanceTheme('light', true)).toBe('light');
    expect(resolveAppearanceTheme('dark', false)).toBe('dark');
  });
});

describe('catalogue search projection', () => {
  it('uses the stored ServiceM8 reference when it differs from the local item number', () => {
    const records = buildCatalogueSearchRecords(
      {
        ...INITIAL_STATE,
        catalogueItems: [
          {
            id: 'product-synthetic',
            itemNumber: 'LOCAL-001',
            description: 'Synthetic lock',
            itemKind: 'physical-product',
            brandId: null,
            markupOverridePercent: null,
            xeroReference: 'XERO-001',
            servicem8Reference: 'SM8-DIFFERENT-001',
            barcodeGtin: null,
            selectedOfferId: 'offer-synthetic',
            costCents: 10_000,
            sellPriceCents: 13_000,
            gstBasis: 'ex-gst',
            sellPriceGstBasis: 'ex-gst',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
        ],
        catalogueSuppliers: [
          {
            id: 'supplier-synthetic',
            name: 'Synthetic supplier',
            active: true,
            externalReference: null,
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
        ],
        supplierOffers: [
          {
            id: 'offer-synthetic',
            productId: 'product-synthetic',
            supplierId: 'supplier-synthetic',
            supplierSku: 'SUPPLIER-001',
            costCents: 10_000,
            gstBasis: 'ex-gst',
            currency: 'AUD',
            active: true,
            isPreferred: false,
            validFrom: null,
            validUntil: null,
            provenanceType: 'manual',
            provenanceReference: null,
            observedAt: '2026-08-20T00:00:00.000Z',
          },
        ],
        offerSelections: [
          {
            productId: 'product-synthetic',
            offerId: 'offer-synthetic',
            selectedBy: 'Synthetic operator',
            reason: 'Explicit synthetic selection',
            selectedAt: '2026-08-20T00:00:00.000Z',
          },
        ],
      },
      '2026-08-20T00:01:00.000Z',
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.document).toMatchObject({
      productId: 'product-synthetic',
      name: 'LOCAL-001',
      servicem8ItemNumber: 'SM8-DIFFERENT-001',
    });
    expect(records[0]?.price.kind).toBe('resolved');
  });

  it('projects explicit, preferred, sole, ambiguous and stale offer states without price sorting', () => {
    const timestamp = '2026-08-20T00:00:00.000Z';
    const asOf = '2026-08-20T00:01:00.000Z';
    const item = (id: string, selectedOfferId: string | null = null) => ({
      id,
      itemNumber: id.toUpperCase(),
      description: `Synthetic ${id}`,
      itemKind: 'physical-product' as const,
      brandId: null,
      markupOverridePercent: null,
      xeroReference: null,
      servicem8Reference: id.toUpperCase(),
      barcodeGtin: null,
      selectedOfferId,
      costCents: 10_000,
      sellPriceCents: 13_000,
      gstBasis: 'ex-gst' as const,
      sellPriceGstBasis: 'ex-gst' as const,
      updatedAt: timestamp,
    });
    const offer = (productId: string, suffix: string, overrides: Record<string, unknown> = {}) => ({
      id: `${productId}-${suffix}`,
      productId,
      supplierId: 'supplier-active',
      supplierSku: `${productId}-${suffix}`.toUpperCase(),
      costCents: suffix === 'high' ? 20_000 : 10_000,
      gstBasis: 'ex-gst' as const,
      currency: 'AUD' as const,
      active: true,
      isPreferred: false,
      validFrom: null,
      validUntil: null,
      provenanceType: 'manual' as const,
      provenanceReference: null,
      observedAt: timestamp,
      ...overrides,
    });
    const records = buildCatalogueSearchRecords(
      {
        ...INITIAL_STATE,
        catalogueItems: [
          item('explicit', 'explicit-high'),
          item('preferred'),
          item('sole'),
          item('ambiguous'),
          item('stale'),
        ],
        catalogueSuppliers: [
          {
            id: 'supplier-active',
            name: 'Active synthetic supplier',
            active: true,
            externalReference: null,
            updatedAt: timestamp,
          },
        ],
        supplierOffers: [
          offer('explicit', 'low'),
          offer('explicit', 'high'),
          offer('preferred', 'low'),
          offer('preferred', 'high', { isPreferred: true }),
          offer('sole', 'only'),
          offer('ambiguous', 'low'),
          offer('ambiguous', 'high'),
          offer('stale', 'only', { validUntil: '2026-08-19T23:59:59.000Z' }),
        ],
      },
      asOf,
    );
    const byId = new Map(records.map((record) => [record.document.productId, record.price]));

    expect(byId.get('explicit')).toMatchObject({
      kind: 'resolved',
      offerId: 'explicit-high',
    });
    expect(byId.get('preferred')).toMatchObject({
      kind: 'resolved',
      offerId: 'preferred-high',
    });
    expect(byId.get('sole')).toMatchObject({ kind: 'resolved', offerId: 'sole-only' });
    expect(byId.get('ambiguous')).toMatchObject({
      kind: 'ambiguous',
      candidateOfferIds: ['ambiguous-low', 'ambiguous-high'],
    });
    expect(byId.get('stale')).toMatchObject({ kind: 'unavailable' });
  });
});
