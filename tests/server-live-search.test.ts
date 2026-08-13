// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFixtureProvider } from '../server/search/fixtureProvider.mjs';
import { ProviderSelectionExpiredError } from '../server/search/providerErrors.mjs';
import {
  createSerpApiProvider,
  MAX_PROVIDER_RESPONSE_BYTES,
} from '../server/search/serpapiProvider.mjs';
import {
  createPaidCallBudgetFromEnvironment,
  createRateLimiter,
  createSearchCache,
  createSearchService,
  priceBandCents,
} from '../server/search/service.mjs';
import { buildProviderQuery, classifyQuery } from '../server/search/normaliseQuery.mjs';
import { LiveSearchOutcomeSchema } from '../src/platform/schemas';

function fixtureService(overrides: Record<string, unknown> = {}) {
  return createSearchService({
    provider: createFixtureProvider(),
    ...overrides,
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...init.headers,
    },
  });
}

function jsonFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Record<
    string,
    unknown
  >;
}

const shoppingDiscoveryFixture = jsonFixture('serpapi-shopping-discovery.json');
const immersiveOffersFixture = jsonFixture('serpapi-immersive-offers.json');

function enabledPaidBudget() {
  return createPaidCallBudgetFromEnvironment({
    SWL_PAID_CALLS_ENABLED: 'true',
    SWL_PROVIDER_COST_CEILING_CENTS: '100',
    SWL_PROVIDER_COST_PER_CALL_CENTS: '5',
  });
}

function validProviderResult(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Synthetic lock',
    priceCents: 10_000,
    gstBasis: 'unknown',
    packSize: null,
    seller: 'Synthetic seller',
    sourceDomain: 'shop.example.test',
    url: 'https://shop.example.test/product/lock',
    ...overrides,
  };
}

describe('live search integration against the fixture provider (offline, no key)', () => {
  it('fails closed for legacy item-only rows without exposing them as evidence', async () => {
    const outcome = await fixtureService().search('LW4570');
    expect(outcome.state).toBe('provider_error');
    expect(outcome.queryKind).toBe('identifier');
    expect(outcome.results).toEqual([]);
    expect(outcome.band).toBeNull();
    expect(outcome.coverage.comparableOffers).toBe(0);
    expect(outcome.coverage.excludedOffers).toBe(0);
    expect(outcome.detail).toContain('legacy item-price payload');
  });

  it('also fails closed for an empty legacy array payload', async () => {
    const outcome = await fixtureService().search('fixture-none');
    expect(outcome.state).toBe('provider_error');
    expect(outcome.results).toEqual([]);
    expect(outcome.band).toBeNull();
  });

  it('reports a provider timeout as the distinct "timeout" state', async () => {
    const outcome = await fixtureService().search('fixture-timeout');
    expect(outcome.state).toBe('timeout');
    expect(outcome.results).toEqual([]);
  });

  it('reports a provider error as the distinct "provider_error" state', async () => {
    const outcome = await fixtureService().search('fixture-error');
    expect(outcome.state).toBe('provider_error');
    expect(outcome.detail).toContain('HTTP 500');
  });

  it('reports quota exhaustion as the distinct "quota_exhausted" state', async () => {
    const outcome = await fixtureService().search('fixture-quota');
    expect(outcome.state).toBe('quota_exhausted');
  });

  it('reports a missing API key as "not_configured" without crashing', async () => {
    const service = createSearchService({
      provider: createSerpApiProvider({}),
    });
    const outcome = await service.search('LW4570');
    expect(outcome.state).toBe('not_configured');
    expect(outcome.detail).toContain('provider credential');
  });

  it('honours the internal timeout with a slow provider', async () => {
    const service = createSearchService({
      provider: createFixtureProvider({ slowMs: 500 }),
      timeoutMs: 50,
    });
    const outcome = await service.search('fixture-slow');
    expect(outcome.state).toBe('timeout');
  });
});

describe('SerpAPI transport and response boundary', () => {
  it('inspects every shopping section without treating inline ads as product clusters', async () => {
    let requestUrl = '';
    let requestOptions: RequestInit | undefined;
    const provider = createSerpApiProvider(
      {
        SERPAPI_KEY: 'synthetic-placeholder',
        SERPAPI_LOCATION: 'Ballarat, Victoria, Australia',
      },
      async (url: string | URL | Request, options?: RequestInit) => {
        requestUrl = String(url);
        requestOptions = options;
        const body = structuredClone(shoppingDiscoveryFixture);
        (body.search_parameters as Record<string, unknown>).location =
          'Ballarat, Victoria, Australia';
        return jsonResponse(body);
      },
    );
    expect(await provider.search('synthetic lock')).toEqual({
      stage: 'discovery',
      candidates: [
        {
          token: 'token-main',
          title: 'Lockwood 001 Double Cylinder Deadlatch',
          brand: null,
          productId: 'product-main',
          productUrl: 'https://www.google.com.au/shopping/product/product-main?gl=au',
          displayedPrice: 'A$129.00',
          priceCents: 12_900,
          multipleSources: true,
          packSize: null,
          condition: 'unknown',
          position: 1,
        },
        {
          token: 'token-used',
          title: 'Used Lockwood 001 Double Cylinder Deadlatch',
          brand: null,
          productId: 'product-used',
          productUrl: 'https://www.google.com.au/shopping/product/product-used?gl=au',
          displayedPrice: '$80.00',
          priceCents: 8_000,
          multipleSources: false,
          packSize: null,
          condition: 'used',
          position: 3,
        },
      ],
      providerMeta: {
        observedAt: '2026-08-10T23:00:02.000Z',
        cacheBasis: 'provider_cache_allowed',
        storesMayContinue: false,
      },
    });
    const parsed = new URL(requestUrl);
    expect(parsed.protocol).toBe('https:');
    expect(parsed.hostname).toBe('serpapi.com');
    expect(parsed.searchParams.get('engine')).toBe('google_shopping');
    expect(parsed.searchParams.get('location')).toBe('Ballarat, Victoria, Australia');
    expect(parsed.searchParams.has('num')).toBe(false);
    expect(requestOptions?.redirect).toBe('manual');
  });

  it('uses the default Geelong locality and then fetches direct immersive store offers', async () => {
    const requestUrls: URL[] = [];
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: 'synthetic-placeholder' },
      async (url: string | URL | Request) => {
        const parsed = new URL(String(url));
        requestUrls.push(parsed);
        return jsonResponse(
          parsed.searchParams.get('engine') === 'google_shopping'
            ? shoppingDiscoveryFixture
            : immersiveOffersFixture,
        );
      },
    );

    await provider.search('synthetic lock');
    const selected = await provider.search('synthetic lock', {
      candidateToken: 'token-main',
    });

    expect(requestUrls).toHaveLength(2);
    const discoveryRequest = requestUrls[0]!;
    const offersRequest = requestUrls[1]!;
    expect(discoveryRequest.searchParams.get('location')).toBe('Geelong, Victoria, Australia');
    expect(discoveryRequest.searchParams.get('device')).toBe('desktop');
    expect(offersRequest.searchParams.get('engine')).toBe('google_immersive_product');
    expect(offersRequest.searchParams.get('page_token')).toBe('token-main');
    expect(offersRequest.searchParams.get('more_stores')).toBe('true');
    expect(offersRequest.searchParams.has('q')).toBe(false);
    expect(offersRequest.searchParams.has('num')).toBe(false);
    expect(selected).toMatchObject({
      stage: 'offers',
      selectedProduct: {
        title: 'Lockwood 001 Double Cylinder Deadlatch',
        brand: 'Lockwood',
        productId: 'product-main',
      },
      providerMeta: {
        observedAt: '2026-08-10T23:05:03.000Z',
        cacheBasis: 'provider_cache_allowed',
        storesMayContinue: true,
      },
    });
    expect(selected.offers).toHaveLength(5);
    expect(selected.offers[0]).toEqual({
      title: 'Lockwood 001 Double Cylinder Deadlatch',
      itemPriceCents: 10_000,
      shippingCents: 1_000,
      estimatedTaxCents: 1_000,
      totalPriceCents: 12_000,
      comparisonPriceCents: 12_000,
      priceBasis: 'provider_total',
      originalPriceText: 'A$100.00',
      currencyBasis: 'explicit-aud',
      gstBasis: 'unknown',
      packSize: null,
      condition: 'unknown',
      availability: 'in-stock',
      financing: false,
      comparisonEligible: true,
      exclusionReasons: [],
      seller: 'Merchant One',
      sourceDomain: 'merchant-one.example.test',
      url: 'https://merchant-one.example.test/products/lockwood-001',
    });
    expect(selected.offers[1]).toMatchObject({
      seller: 'Merchant Two',
      itemPriceCents: 10_500,
      shippingCents: 0,
      totalPriceCents: null,
      comparisonPriceCents: 10_500,
      priceBasis: 'item_plus_shipping',
      comparisonEligible: true,
    });
    expect(selected.offers[2]).toMatchObject({
      seller: 'Finance Merchant',
      financing: true,
      totalPriceCents: null,
      comparisonPriceCents: null,
      priceBasis: 'not_comparable',
      comparisonEligible: false,
      exclusionReasons: ['financing_without_full_total', 'unknown_comparison_total'],
    });
    expect(selected.offers[3]).toMatchObject({
      seller: 'Used Merchant',
      condition: 'used',
      totalPriceCents: 7_000,
      comparisonPriceCents: null,
      comparisonEligible: false,
      exclusionReasons: ['used_or_second_hand'],
    });
    expect(selected.offers[4]).toMatchObject({
      seller: 'Unknown Delivery Merchant',
      shippingCents: null,
      totalPriceCents: null,
      comparisonPriceCents: null,
      comparisonEligible: false,
      exclusionReasons: ['unknown_comparison_total'],
    });
  });

  it('rejects arbitrary, cross-query and refreshed candidate tokens before transport', async () => {
    let calls = 0;
    let discoveryBody = structuredClone(shoppingDiscoveryFixture);
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: 'synthetic-placeholder' },
      async (url: string | URL | Request) => {
        calls += 1;
        const body = structuredClone(discoveryBody);
        (body.search_parameters as Record<string, unknown>).q = new URL(
          String(url),
        ).searchParams.get('q');
        return jsonResponse(body);
      },
    );

    await expect(
      provider.search('query one', { candidateToken: 'not-issued' }),
    ).rejects.toBeInstanceOf(ProviderSelectionExpiredError);
    expect(calls).toBe(0);

    await provider.search('query one');
    await expect(
      provider.search('query two', { candidateToken: 'token-main' }),
    ).rejects.toBeInstanceOf(ProviderSelectionExpiredError);
    expect(calls).toBe(1);

    discoveryBody = JSON.parse(
      JSON.stringify(shoppingDiscoveryFixture).replaceAll('token-main', 'replacement-token'),
    ) as Record<string, unknown>;
    await provider.search('query one');
    await expect(
      provider.search('query one', { candidateToken: 'token-main' }),
    ).rejects.toBeInstanceOf(ProviderSelectionExpiredError);
    expect(calls).toBe(2);
  });

  it('excludes an explicit merchant multi-pack when the selected cluster has no pack claim', async () => {
    const body = structuredClone(immersiveOffersFixture);
    const stores = (body.product_results as Record<string, unknown>).stores as Array<
      Record<string, unknown>
    >;
    stores[0]!.title = 'Lockwood 001 Double Cylinder Deadlatch 2 Pack';
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: 'synthetic-placeholder' },
      async (url: string | URL | Request) =>
        jsonResponse(
          new URL(String(url)).searchParams.get('engine') === 'google_shopping'
            ? shoppingDiscoveryFixture
            : body,
        ),
    );
    await provider.search('synthetic lock');
    const selected = await provider.search('synthetic lock', {
      candidateToken: 'token-main',
    });
    expect(selected.offers[0]).toMatchObject({
      packSize: 'pack of 2',
      comparisonEligible: false,
      comparisonPriceCents: null,
      exclusionReasons: ['pack_mismatch'],
    });
  });

  it('drops offers when numeric and displayed component evidence disagrees', async () => {
    const body = structuredClone(immersiveOffersFixture);
    const product = body.product_results as Record<string, unknown>;
    const baseStore = structuredClone((product.stores as Array<Record<string, unknown>>)[0]!);
    product.stores = [
      { ...baseStore, name: 'Item conflict', extracted_price: 1 },
      {
        ...baseStore,
        name: 'Shipping conflict',
        link: 'https://shipping-conflict.example.test/product',
        shipping_extracted: 1,
      },
      {
        ...baseStore,
        name: 'Tax conflict',
        link: 'https://tax-conflict.example.test/product',
        extracted_estimated_tax: 1,
      },
      {
        ...baseStore,
        name: 'Total conflict',
        link: 'https://total-conflict.example.test/product',
        extracted_total: 1,
      },
    ];
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: 'synthetic-placeholder' },
      async (url: string | URL | Request) =>
        jsonResponse(
          new URL(String(url)).searchParams.get('engine') === 'google_shopping'
            ? shoppingDiscoveryFixture
            : body,
        ),
    );
    await provider.search('synthetic lock');
    const selected = await provider.search('synthetic lock', {
      candidateToken: 'token-main',
    });
    expect(selected.offers).toEqual([]);
  });

  it('does not use a conflicting discovery price as candidate numeric evidence', async () => {
    const body = structuredClone(shoppingDiscoveryFixture);
    const first = (body.shopping_results as Array<Record<string, unknown>>)[0]!;
    first.extracted_price = 1;
    const provider = createSerpApiProvider({ SERPAPI_KEY: 'synthetic-placeholder' }, async () =>
      jsonResponse(body),
    );
    const discovery = await provider.search('synthetic lock');
    expect(discovery.candidates[0]).toMatchObject({
      displayedPrice: 'A$129.00',
      priceCents: null,
    });
  });

  it.each([
    ['wrong engine', { engine: 'google_shopping', page_token: 'token-main' }],
    ['wrong token', { engine: 'google_immersive_product', page_token: 'token-other' }],
  ])('rejects an immersive response with %s', async (_case, parameters) => {
    const body = structuredClone(immersiveOffersFixture);
    body.search_parameters = parameters;
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: 'synthetic-placeholder' },
      async (url: string | URL | Request) =>
        jsonResponse(
          new URL(String(url)).searchParams.get('engine') === 'google_shopping'
            ? shoppingDiscoveryFixture
            : body,
        ),
    );
    await provider.search('synthetic lock');
    await expect(
      provider.search('synthetic lock', { candidateToken: 'token-main' }),
    ).rejects.toThrow('response parameters');
  });

  it('rejects a Shopping response whose echoed AU localisation disagrees', async () => {
    const body = structuredClone(shoppingDiscoveryFixture);
    (body.search_parameters as Record<string, unknown>).gl = 'us';
    const provider = createSerpApiProvider({ SERPAPI_KEY: 'synthetic-placeholder' }, async () =>
      jsonResponse(body),
    );
    await expect(provider.search('synthetic lock')).rejects.toThrow('localisation');
  });

  it('rejects a Shopping response whose echoed query targets another product', async () => {
    const body = structuredClone(shoppingDiscoveryFixture);
    (body.search_parameters as Record<string, unknown>).q = 'different product';
    const provider = createSerpApiProvider({ SERPAPI_KEY: 'synthetic-placeholder' }, async () =>
      jsonResponse(body),
    );
    await expect(provider.search('synthetic lock')).rejects.toThrow('response query');
  });

  it('deduplicates tracking variants of the same merchant offer', async () => {
    const body = structuredClone(immersiveOffersFixture);
    const stores = (body.product_results as Record<string, unknown>).stores as Array<
      Record<string, unknown>
    >;
    stores[1]!.link =
      'https://merchant-one.example.test/products/lockwood-001?utm_source=shopping&gclid=synthetic';
    stores[1]!.details_and_offers = ['Sold out'];
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: 'synthetic-placeholder' },
      async (url: string | URL | Request) =>
        jsonResponse(
          new URL(String(url)).searchParams.get('engine') === 'google_shopping'
            ? shoppingDiscoveryFixture
            : body,
        ),
    );
    await provider.search('synthetic lock');
    const selected = await provider.search('synthetic lock', {
      candidateToken: 'token-main',
    });
    expect(selected.offers).toHaveLength(5);
    const merchantOne = selected.offers.filter(
      (offer: { seller: string }) => offer.seller === 'Merchant One',
    );
    expect(merchantOne).toHaveLength(1);
    expect(merchantOne[0]).toMatchObject({
      availability: 'out-of-stock',
      comparisonEligible: false,
      exclusionReasons: ['out_of_stock'],
    });
  });

  it('rejects a redirect without following its target', async () => {
    let calls = 0;
    const provider = createSerpApiProvider({ SERPAPI_KEY: 'synthetic-placeholder' }, async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://unapproved.example.test/collect' },
      });
    });
    await expect(provider.search('synthetic lock')).rejects.toThrow('redirect rejected');
    expect(calls).toBe(1);
  });

  it('rejects declared and streamed responses above the byte ceiling', async () => {
    const declared = createSerpApiProvider(
      { SERPAPI_KEY: 'synthetic-placeholder' },
      async () =>
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            'content-length': String(MAX_PROVIDER_RESPONSE_BYTES + 1),
          },
        }),
    );
    await expect(declared.search('synthetic lock')).rejects.toThrow('response size');

    const streamed = createSerpApiProvider(
      { SERPAPI_KEY: 'synthetic-placeholder' },
      async () =>
        new Response(`{"padding":"${'x'.repeat(MAX_PROVIDER_RESPONSE_BYTES)}"}`, {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(streamed.search('synthetic lock')).rejects.toThrow('response size');
  });

  it('deterministically drops malformed provider items before the shared result boundary', async () => {
    const malformed = structuredClone(shoppingDiscoveryFixture);
    const shoppingResults = malformed.shopping_results as Array<Record<string, unknown>>;
    shoppingResults.push(
      {
        position: 8,
        title: 'Credential cluster URL',
        product_id: 'bad-credential-url',
        product_link: 'https://user:pass@www.google.com.au/shopping/product/x',
        immersive_product_page_token: 'bad-token-one',
      },
      {
        position: 9,
        title: 'Oversized token',
        product_id: 'bad-token',
        product_link: 'https://www.google.com.au/shopping/product/x',
        immersive_product_page_token: 'x'.repeat(8_193),
      },
    );
    const provider = createSerpApiProvider({ SERPAPI_KEY: 'synthetic-placeholder' }, async () =>
      jsonResponse(malformed),
    );
    const result = await provider.search('synthetic lock');
    expect(result.stage).toBe('discovery');
    expect(result.candidates).toHaveLength(2);
  });
});

describe('two-stage comparison service contract', () => {
  function twoStageService(immersiveBody = immersiveOffersFixture) {
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: 'synthetic-placeholder' },
      async (url: string | URL | Request) => {
        const request = new URL(String(url));
        if (request.searchParams.get('engine') !== 'google_shopping') {
          return jsonResponse(immersiveBody);
        }
        const body = structuredClone(shoppingDiscoveryFixture);
        (body.search_parameters as Record<string, unknown>).q = request.searchParams.get('q');
        return jsonResponse(body);
      },
    );
    return createSearchService({
      provider,
      paidCallBudget: enabledPaidBudget(),
      clock: () => '2026-08-11T00:00:00.000Z',
    });
  }

  it('requires product selection before comparing merchant offers', async () => {
    const outcome = await twoStageService().search('Lockwood 001');
    expect(outcome).toMatchObject({
      state: 'selection_required',
      results: [],
      band: null,
      retrievedAt: '2026-08-10T23:00:02.000Z',
      cached: false,
      coverage: {
        providerCandidates: 2,
        parsedOffers: 0,
        comparableOffers: 0,
        excludedOffers: 0,
      },
    });
    expect(outcome.candidates).toHaveLength(2);
    expect(outcome.candidates[0]).toMatchObject({
      token: 'token-main',
      title: 'Lockwood 001 Double Cylinder Deadlatch',
      productId: 'product-main',
    });
    expect(() => LiveSearchOutcomeSchema.parse(outcome)).not.toThrow();
  });

  it('compares only deduplicated, eligible delivered prices after selection', async () => {
    const service = twoStageService();
    await service.search('Lockwood 001');
    const outcome = await service.search('Lockwood 001', 'token-main');

    expect(outcome.state).toBe('ok');
    expect(outcome.candidates).toEqual([]);
    expect(outcome.selectedProduct).toEqual({
      title: 'Lockwood 001 Double Cylinder Deadlatch',
      brand: 'Lockwood',
      productId: 'product-main',
    });
    expect(outcome.results).toHaveLength(5);
    expect(outcome.results[0]).toMatchObject({
      priceCents: 10_000,
      priceAud: '100.00',
      itemPriceCents: 10_000,
      itemPriceAud: '100.00',
      shippingCents: 1_000,
      shippingAud: '10.00',
      estimatedTaxCents: 1_000,
      estimatedTaxAud: '10.00',
      totalPriceCents: 12_000,
      totalPriceAud: '120.00',
      comparisonPriceCents: 12_000,
      comparisonPriceAud: '120.00',
      comparisonEligible: true,
      currency: 'AUD',
      retrievedAt: '2026-08-10T23:05:03.000Z',
    });
    expect(outcome.band).toMatchObject({
      lowestCents: 10_500,
      medianCents: 11_250,
      highestCents: 12_000,
      pricedResults: 2,
    });
    expect(outcome.coverage).toEqual({
      providerQueried: 'serpapi-google-shopping-au',
      sourcesWithPrice: 5,
      sourceDomains: [
        'merchant-one.example.test',
        'merchant-two.example.test',
        'finance-merchant.example.test',
        'used-merchant.example.test',
        'unknown-delivery.example.test',
      ],
      pricedResults: 2,
      providerCandidates: 0,
      parsedOffers: 5,
      comparableOffers: 2,
      excludedOffers: 3,
    });
    expect(outcome.detail).toContain('not exhaustive');
    expect(() => LiveSearchOutcomeSchema.parse(outcome)).not.toThrow();
  });

  it('returns "no_comparable_offers" when every direct offer is excluded', async () => {
    const noComparable = structuredClone(immersiveOffersFixture);
    const productResults = noComparable.product_results as Record<string, unknown>;
    productResults.stores = (productResults.stores as Array<Record<string, unknown>>).filter(
      (store) =>
        ['Finance Merchant', 'Used Merchant', 'Unknown Delivery Merchant'].includes(
          String(store.name),
        ),
    );
    delete productResults.stores_next_page_token;

    const service = twoStageService(noComparable);
    await service.search('Lockwood 001');
    const outcome = await service.search('Lockwood 001', 'token-main');
    expect(outcome).toMatchObject({
      state: 'no_comparable_offers',
      band: null,
      coverage: {
        parsedOffers: 3,
        comparableOffers: 0,
        excludedOffers: 3,
      },
    });
    expect(outcome.results).toHaveLength(3);
  });

  it('reports zero parsed merchant offers without claiming offers were found', async () => {
    const emptyStores = structuredClone(immersiveOffersFixture);
    const product = emptyStores.product_results as Record<string, unknown>;
    product.stores = [];
    delete product.stores_next_page_token;
    const service = twoStageService(emptyStores);
    await service.search('Lockwood 001');
    const outcome = await service.search('Lockwood 001', 'token-main');
    expect(outcome).toMatchObject({
      state: 'no_comparable_offers',
      results: [],
      band: null,
      coverage: {
        parsedOffers: 0,
        comparableOffers: 0,
        excludedOffers: 0,
      },
    });
    expect(outcome.detail).toContain('No direct merchant offers');
    expect(outcome.detail).not.toContain('offers were found');
  });

  it('rejects an oversized candidate token before any provider call', async () => {
    let calls = 0;
    const service = createSearchService({
      provider: {
        name: 'synthetic-provider',
        configured: true,
        requiresPaidCall: false,
        async search() {
          calls += 1;
          return [];
        },
      },
    });
    expect(await service.search('Lockwood 001', 'x'.repeat(8_193))).toMatchObject({
      state: 'invalid_query',
      candidates: [],
      results: [],
    });
    expect(calls).toBe(0);
  });

  it('returns selection_expired before rate, budget, cache or transport work', async () => {
    let calls = 0;
    let rateCalls = 0;
    const budget = enabledPaidBudget();
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: 'synthetic-placeholder' },
      async (url: string | URL | Request) => {
        calls += 1;
        const body = structuredClone(shoppingDiscoveryFixture);
        (body.search_parameters as Record<string, unknown>).q = new URL(
          String(url),
        ).searchParams.get('q');
        return jsonResponse(body);
      },
    );
    const service = createSearchService({
      provider,
      paidCallBudget: budget,
      rateLimiter: {
        tryTake() {
          rateCalls += 1;
          return true;
        },
      },
    });

    expect(await service.search('Lockwood 001')).toMatchObject({
      state: 'selection_required',
    });
    expect(await service.search('Different product', 'token-main')).toMatchObject({
      state: 'selection_expired',
      results: [],
      band: null,
    });
    expect(calls).toBe(1);
    expect(rateCalls).toBe(1);
    expect(budget.status().reservedCents).toBe(5);
  });
});

describe('shared provider-result validation', () => {
  function serviceFor(result: unknown) {
    return createSearchService({
      provider: {
        name: 'synthetic-provider',
        configured: true,
        requiresPaidCall: false,
        async search() {
          return result;
        },
      },
    });
  }

  it.each([
    ['unknown full-row field', [validProviderResult({ supplierCostCents: 9_000 })]],
    ['secret field', [validProviderResult({ apiKey: 'synthetic-placeholder' })]],
    ['price outside the product maximum', [validProviderResult({ priceCents: 1_000_000_001 })]],
    ['oversized text', [validProviderResult({ title: 'x'.repeat(1_001) })]],
    ['credential URL', [validProviderResult({ url: 'https://u:p@shop.example.test/x' })]],
    ['non-HTTPS URL', [validProviderResult({ url: 'http://shop.example.test/x' })]],
    ['source host mismatch', [validProviderResult({ sourceDomain: 'other.example.test' })]],
    ['too many results', Array.from({ length: 101 }, () => validProviderResult())],
  ])('returns provider_error for %s without exposing a result', async (_case, result) => {
    expect(await serviceFor(result).search('synthetic lock')).toMatchObject({
      state: 'provider_error',
      results: [],
    });
  });

  it('rejects oversized and control-character queries before any provider call', async () => {
    let calls = 0;
    const service = createSearchService({
      provider: {
        name: 'synthetic-provider',
        configured: true,
        requiresPaidCall: false,
        async search() {
          calls += 1;
          return [validProviderResult()];
        },
      },
    });
    expect(await service.search('x'.repeat(513))).toMatchObject({
      state: 'invalid_query',
    });
    expect(await service.search('lock\u0000query')).toMatchObject({
      state: 'invalid_query',
    });
    expect(calls).toBe(0);
  });
});

describe('rate limiting and caching', () => {
  it('limits outbound provider calls and reports rate_limited distinctly', async () => {
    const service = fixtureService({
      rateLimiter: createRateLimiter({ capacity: 2 }),
    });
    expect((await service.search('query one')).state).toBe('provider_error');
    expect((await service.search('query two')).state).toBe('provider_error');
    const third = await service.search('query three');
    expect(third.state).toBe('rate_limited');
  });

  it('serves repeat queries from cache with the original retrieval timestamp', async () => {
    let t = 0;
    const service = fixtureService({
      cache: createSearchCache({ now: () => t }),
      clock: () => '2026-08-05T00:00:00.000Z',
    });
    const first = await service.search('AB9053');
    t = 60_000;
    const second = await service.search('AB9053');
    expect(second.cached).toBe(true);
    expect(second.retrievedAt).toBe(first.retrievedAt);
  });
});

describe('paid provider cost ceiling', () => {
  function paidProvider(onCall: () => void) {
    return {
      name: 'synthetic-paid-provider',
      configured: true,
      requiresPaidCall: true,
      async search(query: string) {
        onCall();
        return [
          {
            title: `Synthetic result ${query}`,
            priceCents: 10_000,
            gstBasis: 'unknown',
            packSize: null,
            seller: 'Synthetic seller',
            sourceDomain: 'example.test',
            url: 'https://example.test/product',
          },
        ];
      },
    };
  }

  it('refuses paid network calls by default even when a credential-configured provider exists', async () => {
    let calls = 0;
    const budget = createPaidCallBudgetFromEnvironment({});
    const service = createSearchService({
      provider: paidProvider(() => {
        calls += 1;
      }),
      paidCallBudget: budget,
    });
    expect(await service.search('LW4570')).toMatchObject({
      state: 'not_configured',
    });
    expect(calls).toBe(0);
    expect(budget.status()).toMatchObject({
      state: 'disabled',
      ceilingCents: 0,
    });
  });

  it('fails closed when any mandatory paid-call budget setting is missing or malformed', async () => {
    let calls = 0;
    const budget = createPaidCallBudgetFromEnvironment({
      SWL_PAID_CALLS_ENABLED: 'true',
      SWL_PROVIDER_COST_CEILING_CENTS: '100',
    });
    const service = createSearchService({
      provider: paidProvider(() => {
        calls += 1;
      }),
      paidCallBudget: budget,
    });
    expect(budget.status().state).toBe('invalid');
    expect(await service.search('LW4570')).toMatchObject({
      state: 'not_configured',
    });
    expect(calls).toBe(0);
  });

  it('reserves the declared per-call cost and refuses calls beyond the explicit ceiling', async () => {
    let calls = 0;
    const budget = createPaidCallBudgetFromEnvironment({
      SWL_PAID_CALLS_ENABLED: 'true',
      SWL_PROVIDER_COST_CEILING_CENTS: '10',
      SWL_PROVIDER_COST_PER_CALL_CENTS: '5',
    });
    const service = createSearchService({
      provider: paidProvider(() => {
        calls += 1;
      }),
      paidCallBudget: budget,
    });
    expect((await service.search('paid one')).state).toBe('provider_error');
    expect((await service.search('paid two')).state).toBe('provider_error');
    expect(await service.search('paid three')).toMatchObject({
      state: 'quota_exhausted',
    });
    expect(calls).toBe(2);
    expect(budget.status()).toMatchObject({
      state: 'exhausted',
      reservedCents: 10,
    });
  });

  it('keeps the deterministic fixture exempt from paid-call reservations', async () => {
    const budget = createPaidCallBudgetFromEnvironment({});
    const outcome = await createSearchService({
      provider: createFixtureProvider(),
      paidCallBudget: budget,
    }).search('LW4570');
    expect(outcome.state).toBe('provider_error');
    expect(budget.status()).toMatchObject({
      state: 'disabled',
      reservedCents: 0,
    });
  });
});

describe('query normalisation and classification', () => {
  it('detects identifiers, barcodes and free text without a type selector', () => {
    expect(classifyQuery('lw4570')).toBe('identifier');
    expect(classifyQuery('9312345678907')).toBe('barcode');
    expect(classifyQuery('lockwood deadlatch satin chrome')).toBe('free-text');
    expect(classifyQuery('')).toBe('empty');
  });
  it('quotes identifiers for the provider and passes free text through', () => {
    expect(buildProviderQuery('  LW4570 ').providerQuery).toBe('"LW4570"');
    expect(buildProviderQuery('lockwood  deadlatch').providerQuery).toBe('lockwood deadlatch');
  });
});

describe('price band in integer cents', () => {
  it('computes lowest, median and highest with half-up integer median', () => {
    const band = priceBandCents([
      { priceCents: 12995 },
      { priceCents: 14350 },
      { priceCents: 13900 },
      { priceCents: 26500 },
    ]);
    expect(band.lowest).toBe('129.95');
    expect(band.median).toBe('141.25');
    expect(band.highest).toBe('265.00');
    expect(band.pricedResults).toBe(4);
  });
});
