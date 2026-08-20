import { describe, expect, it } from 'vitest';
import {
  LiveSearchOutcomeSchema,
  LiveSearchResultSchema,
  OfferSelectionRecordSchema,
  SupplierOfferRecordSchema,
} from './schemas';

function supplierOffer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'offer-synthetic',
    productId: 'product-synthetic',
    supplierId: 'supplier-synthetic',
    supplierSku: 'SKU-SYNTHETIC',
    costCents: 10_000,
    gstBasis: 'ex-gst',
    currency: 'AUD',
    active: true,
    isPreferred: false,
    validFrom: '2026-08-20T10:00:00+10:00',
    validUntil: '2026-08-20T00:30:00Z',
    provenanceType: 'manual',
    provenanceReference: null,
    observedAt: '2026-08-20T00:00:00Z',
    ...overrides,
  };
}

describe('supplier offer time boundaries', () => {
  it('orders offset timestamps by the represented instant rather than their text', () => {
    expect(SupplierOfferRecordSchema.safeParse(supplierOffer()).success).toBe(true);
  });

  it('rejects reversed validity and timestamps without an explicit timezone', () => {
    expect(
      SupplierOfferRecordSchema.safeParse(
        supplierOffer({
          validFrom: '2026-08-20T00:31:00Z',
          validUntil: '2026-08-20T00:30:00Z',
        }),
      ).success,
    ).toBe(false);
    expect(
      SupplierOfferRecordSchema.safeParse(supplierOffer({ observedAt: '2026-08-20T00:00:00' }))
        .success,
    ).toBe(false);
    expect(
      OfferSelectionRecordSchema.safeParse({
        productId: 'product-synthetic',
        offerId: 'offer-synthetic',
        selectedBy: 'Operator',
        reason: 'Explicit synthetic selection',
        selectedAt: '2026-08-20T00:00:00',
      }).success,
    ).toBe(false);
  });
});

function eligibleResult(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Synthetic merchant offer',
    priceCents: 10_000,
    priceAud: '100.00',
    itemPriceCents: 10_000,
    itemPriceAud: '100.00',
    shippingCents: 500,
    shippingAud: '5.00',
    estimatedTaxCents: 100,
    estimatedTaxAud: '1.00',
    totalPriceCents: 10_600,
    totalPriceAud: '106.00',
    comparisonPriceCents: 10_600,
    comparisonPriceAud: '106.00',
    priceBasis: 'provider_total',
    originalPriceText: 'A$100.00',
    currencyBasis: 'explicit-aud',
    currency: 'AUD',
    gstBasis: 'unknown',
    packSize: null,
    condition: 'new',
    availability: 'in-stock',
    financing: false,
    comparisonEligible: true,
    exclusionReasons: [],
    seller: 'Merchant One',
    sourceDomain: 'merchant-one.example.test',
    url: 'https://merchant-one.example.test/products/lock',
    retrievedAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

function secondEligibleResult() {
  return eligibleResult({
    title: 'Second synthetic merchant offer',
    priceCents: 12_000,
    priceAud: '120.00',
    itemPriceCents: 12_000,
    itemPriceAud: '120.00',
    shippingCents: 1,
    shippingAud: '0.01',
    estimatedTaxCents: null,
    estimatedTaxAud: null,
    totalPriceCents: null,
    totalPriceAud: null,
    comparisonPriceCents: 12_001,
    comparisonPriceAud: '120.01',
    priceBasis: 'item_plus_shipping',
    seller: 'Merchant Two',
    sourceDomain: 'merchant-two.example.test',
    url: 'https://merchant-two.example.test/products/lock',
  });
}

function excludedResult() {
  return eligibleResult({
    title: 'Excluded synthetic merchant offer',
    priceCents: 9_000,
    priceAud: '90.00',
    itemPriceCents: 9_000,
    itemPriceAud: '90.00',
    shippingCents: null,
    shippingAud: null,
    estimatedTaxCents: null,
    estimatedTaxAud: null,
    totalPriceCents: null,
    totalPriceAud: null,
    comparisonPriceCents: null,
    comparisonPriceAud: null,
    priceBasis: 'not_comparable',
    comparisonEligible: false,
    exclusionReasons: ['unknown_comparison_total'],
    seller: 'Merchant Three',
    sourceDomain: 'merchant-three.example.test',
    url: 'https://merchant-three.example.test/products/lock',
  });
}

function withSelectionProvenance(
  result: ReturnType<typeof eligibleResult>,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...result,
    searchQuery: 'LW4570',
    selectedProductTitle: 'Synthetic selected lock',
    selectedProductBrand: 'Synthetic',
    selectedProductId: 'LW4570',
    ...overrides,
  };
}

function withoutSelectionProvenance(
  result: ReturnType<typeof eligibleResult>,
): ReturnType<typeof withSelectionProvenance> {
  const legacy = { ...result } as Record<string, unknown>;
  delete legacy.searchQuery;
  delete legacy.selectedProductTitle;
  delete legacy.selectedProductBrand;
  delete legacy.selectedProductId;
  return legacy as ReturnType<typeof withSelectionProvenance>;
}

function validOutcome() {
  return {
    state: 'ok',
    query: 'LW4570',
    queryKind: 'identifier',
    provider: 'serpapi-google-shopping-au',
    candidates: [],
    selectedProduct: {
      title: 'Synthetic selected lock',
      brand: 'Synthetic',
      productId: 'LW4570',
    },
    results: [
      withSelectionProvenance(eligibleResult()),
      withSelectionProvenance(secondEligibleResult()),
      withSelectionProvenance(excludedResult()),
    ],
    band: {
      lowest: '106.00',
      median: '113.01',
      highest: '120.01',
      lowestCents: 10_600,
      medianCents: 11_301,
      highestCents: 12_001,
      pricedResults: 2,
    },
    retrievedAt: '2026-08-11T00:00:00.000Z',
    cached: false,
    coverage: {
      providerQueried: 'serpapi-google-shopping-au',
      sourcesWithPrice: 3,
      sourceDomains: [
        'merchant-one.example.test',
        'merchant-two.example.test',
        'merchant-three.example.test',
      ],
      pricedResults: 2,
      providerCandidates: 0,
      parsedOffers: 3,
      comparableOffers: 2,
      excludedOffers: 1,
    },
  };
}

describe('LiveSearchResultSchema semantic boundary', () => {
  it('accepts an internally consistent direct merchant offer', () => {
    expect(LiveSearchResultSchema.safeParse(eligibleResult()).success).toBe(true);
  });

  it('accepts complete selection provenance and Rust-style null legacy fields', () => {
    expect(
      LiveSearchResultSchema.safeParse(
        eligibleResult({
          searchQuery: 'LW4570',
          selectedProductTitle: 'Synthetic selected lock',
          selectedProductBrand: null,
          selectedProductId: 'LW4570',
        }),
      ).success,
    ).toBe(true);
    expect(
      LiveSearchResultSchema.safeParse(
        eligibleResult({
          searchQuery: null,
          selectedProductTitle: null,
          selectedProductBrand: null,
          selectedProductId: null,
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    {
      searchQuery: 'LW4570',
      selectedProductTitle: null,
      selectedProductBrand: null,
      selectedProductId: null,
    },
    {
      searchQuery: null,
      selectedProductTitle: 'Synthetic selected lock',
      selectedProductBrand: null,
      selectedProductId: null,
    },
    {
      searchQuery: null,
      selectedProductTitle: null,
      selectedProductBrand: 'Synthetic',
      selectedProductId: null,
    },
  ])('rejects partial selection provenance: %o', (provenance) => {
    expect(LiveSearchResultSchema.safeParse(eligibleResult(provenance)).success).toBe(false);
  });

  it.each([
    ['priceAud', '99.99'],
    ['itemPriceAud', '99.99'],
    ['shippingAud', '4.99'],
    ['estimatedTaxAud', '0.99'],
    ['totalPriceAud', '105.99'],
    ['comparisonPriceAud', '105.99'],
    ['shippingAud', null],
  ])('rejects cents/AUD disagreement in %s', (field, invalidValue) => {
    expect(
      LiveSearchResultSchema.safeParse(eligibleResult({ [field]: invalidValue })).success,
    ).toBe(false);
  });

  it('rejects an AUD amount when its nullable cents component is absent', () => {
    expect(
      LiveSearchResultSchema.safeParse(
        eligibleResult({
          estimatedTaxCents: null,
          estimatedTaxAud: '1.00',
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects disagreement between the backwards-compatible and item-price aliases', () => {
    expect(
      LiveSearchResultSchema.safeParse(eligibleResult({ priceCents: 9_999, priceAud: '99.99' }))
        .success,
    ).toBe(false);
  });

  it.each([
    { exclusionReasons: ['unexpected_exclusion'] },
    { comparisonPriceCents: null, comparisonPriceAud: null },
    { priceBasis: 'not_comparable' },
    { comparisonPriceCents: 10_599, comparisonPriceAud: '105.99' },
    {
      priceBasis: 'item_plus_shipping',
      comparisonPriceCents: 10_499,
      comparisonPriceAud: '104.99',
    },
    {
      priceBasis: 'item_plus_shipping',
      comparisonPriceCents: 10_500,
      comparisonPriceAud: '105.00',
      totalPriceCents: null,
      totalPriceAud: null,
    },
  ])('rejects an inconsistent eligible offer: %o', (mutation) => {
    expect(LiveSearchResultSchema.safeParse(eligibleResult(mutation)).success).toBe(false);
  });

  it.each([
    {
      comparisonEligible: false,
      exclusionReasons: ['excluded'],
    },
    {
      comparisonEligible: false,
      exclusionReasons: ['excluded'],
      comparisonPriceCents: null,
      comparisonPriceAud: null,
      priceBasis: 'provider_total',
    },
    {
      comparisonEligible: false,
      exclusionReasons: [],
      comparisonPriceCents: null,
      comparisonPriceAud: null,
      priceBasis: 'not_comparable',
    },
  ])('rejects an inconsistent excluded offer: %o', (mutation) => {
    expect(LiveSearchResultSchema.safeParse(eligibleResult(mutation)).success).toBe(false);
  });

  it.each([
    {
      financing: true,
      totalPriceCents: null,
      totalPriceAud: null,
      estimatedTaxCents: null,
      estimatedTaxAud: null,
      comparisonPriceCents: 10_500,
      comparisonPriceAud: '105.00',
      priceBasis: 'item_plus_shipping',
    },
    { condition: 'used' },
    { availability: 'out-of-stock' },
  ])('rejects an ineligible offer marked comparison eligible: %o', (mutation) => {
    expect(LiveSearchResultSchema.safeParse(eligibleResult(mutation)).success).toBe(false);
  });

  it.each([
    {
      sourceDomain: 'other-merchant.example.test',
    },
    {
      sourceDomain: 'www.google.com.au',
      url: 'https://www.google.com.au/shopping/product/LW4570',
    },
    {
      sourceDomain: 'api.serpapi.com',
      url: 'https://api.serpapi.com/search.json',
    },
    {
      sourceDomain: 'www.googleadservices.com',
      url: 'https://www.googleadservices.com/pagead/aclk',
    },
    {
      url: 'https://merchant-one.example.test:8443/products/lock',
    },
  ])('rejects a non-merchant result URL: %o', (mutation) => {
    expect(LiveSearchResultSchema.safeParse(eligibleResult(mutation)).success).toBe(false);
  });

  it('returns a validation failure instead of throwing for a malformed URL', () => {
    const parse = () => LiveSearchResultSchema.safeParse(eligibleResult({ url: 'not a URL' }));
    expect(parse).not.toThrow();
    expect(parse().success).toBe(false);
  });
});

describe('LiveSearchOutcomeSchema semantic boundary', () => {
  it('accepts an outcome whose band and coverage are derived from its results', () => {
    expect(LiveSearchOutcomeSchema.safeParse(validOutcome()).success).toBe(true);
  });

  it('accepts result provenance that matches the enclosing selection', () => {
    const outcome = validOutcome();
    outcome.results = outcome.results.map((result) => ({
      ...result,
      searchQuery: 'LW4570',
      selectedProductTitle: 'Synthetic selected lock',
      selectedProductBrand: 'Synthetic',
      selectedProductId: 'LW4570',
    }));
    expect(LiveSearchOutcomeSchema.safeParse(outcome).success).toBe(true);
  });

  it.each([
    ['searchQuery', 'different query'],
    ['selectedProductTitle', 'Different selected product'],
    ['selectedProductBrand', 'Different brand'],
    ['selectedProductId', 'different-product-id'],
  ])('rejects result provenance that disagrees in %s', (field, invalidValue) => {
    const outcome = validOutcome();
    outcome.results[0] = {
      ...outcome.results[0]!,
      [field]: invalidValue,
    };
    expect(LiveSearchOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('requires complete provenance on every live result in a result outcome', () => {
    const missingAllProvenance = validOutcome();
    missingAllProvenance.results = missingAllProvenance.results.map(withoutSelectionProvenance);
    expect(LiveSearchOutcomeSchema.safeParse(missingAllProvenance).success).toBe(false);

    const mixedProvenance = validOutcome();
    mixedProvenance.results[1] = withoutSelectionProvenance(mixedProvenance.results[1]!);
    expect(LiveSearchOutcomeSchema.safeParse(mixedProvenance).success).toBe(false);
  });

  it.each([
    { lowest: '105.99' },
    { median: '113.00' },
    { highest: '120.00' },
    { lowestCents: 10_599 },
    { medianCents: 11_300 },
    { highestCents: 12_000 },
    { pricedResults: 3 },
  ])('rejects a band not exactly derived from eligible prices: %o', (band) => {
    const outcome = validOutcome();
    outcome.band = { ...outcome.band, ...band };
    expect(LiveSearchOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('requires a null band when there are no comparable results', () => {
    const outcome = validOutcome();
    outcome.state = 'no_comparable_offers';
    outcome.results = [withSelectionProvenance(excludedResult())];
    outcome.coverage = {
      ...outcome.coverage,
      sourcesWithPrice: 1,
      sourceDomains: ['merchant-three.example.test'],
      pricedResults: 0,
      parsedOffers: 1,
      comparableOffers: 0,
      excludedOffers: 1,
    };
    expect(LiveSearchOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it.each([
    { providerQueried: 'different-provider' },
    { sourcesWithPrice: 2 },
    {
      sourceDomains: ['merchant-one.example.test', 'merchant-two.example.test'],
    },
    { pricedResults: 3 },
    { providerCandidates: 1 },
    { parsedOffers: 2 },
    { comparableOffers: 1 },
    { excludedOffers: 2 },
  ])('rejects internally inconsistent coverage: %o', (coverage) => {
    const outcome = validOutcome();
    outcome.coverage = { ...outcome.coverage, ...coverage };
    expect(LiveSearchOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it.each(['ok', 'no_comparable_offers'])(
    'requires selectedProduct for the %s result state',
    (state) => {
      const outcome = validOutcome() as Record<string, unknown>;
      outcome.state = state;
      if (state === 'no_comparable_offers') {
        outcome.results = [withSelectionProvenance(excludedResult())];
        outcome.band = null;
        outcome.coverage = {
          providerQueried: 'serpapi-google-shopping-au',
          sourcesWithPrice: 1,
          sourceDomains: ['merchant-three.example.test'],
          pricedResults: 0,
          providerCandidates: 0,
          parsedOffers: 1,
          comparableOffers: 0,
          excludedOffers: 1,
        };
      }
      delete outcome.selectedProduct;
      expect(LiveSearchOutcomeSchema.safeParse(outcome).success).toBe(false);
    },
  );

  it('rejects a selected product outside result states', () => {
    const outcome = {
      ...validOutcome(),
      state: 'selection_required',
      candidates: [],
      results: [],
      band: null,
      coverage: undefined,
    };
    expect(LiveSearchOutcomeSchema.safeParse(outcome).success).toBe(false);
  });

  it('preserves selection_expired with nullable selection metadata', () => {
    const outcome = {
      ...validOutcome(),
      state: 'selection_expired',
      selectedProduct: null,
      candidates: [],
      results: [],
      band: null,
      coverage: undefined,
    };
    expect(LiveSearchOutcomeSchema.safeParse(outcome).success).toBe(true);
  });
});
