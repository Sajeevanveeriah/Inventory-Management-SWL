// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createEbayBrowseProvider } from '../server/search/ebayBrowseProvider.mjs';
import {
  createProviderFromEnvironment,
  optionalProviderRegistry,
} from '../server/search/providerRegistry.mjs';
import { createSerperShoppingProvider } from '../server/search/serperShoppingProvider.mjs';
import { MAX_FREE_PROVIDER_RESPONSE_BYTES } from '../server/search/freeProviderUtils.mjs';
import { createSearchService } from '../server/search/service.mjs';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

describe('optional competitor provider adapters', () => {
  it('uses a Serper key from the environment and returns direct AUD offers', async () => {
    let requestUrl = '';
    let requestOptions: RequestInit | undefined;
    const provider = createSerperShoppingProvider(
      { SERPER_API_KEY: 'fixture-serper-key' },
      async (url: string | URL | Request, options?: RequestInit) => {
        requestUrl = String(url);
        requestOptions = options;
        return jsonResponse({
          shopping: [
            {
              title: 'Lockwood 001 Double Cylinder Deadlatch - New',
              source: 'Synthetic Locksmith Supply',
              link: 'https://shop.example.test/locks/lockwood-001#offer',
              price: 'A$129.00',
              extractedPrice: 129,
              delivery: 'Free delivery',
              availability: 'In stock',
            },
          ],
        });
      },
    );
    const outcome = await createSearchService({
      provider,
      clock: () => '2026-08-12T00:00:00.000Z',
    }).search('LW4570');

    expect(requestUrl).toBe('https://google.serper.dev/shopping');
    expect(new Headers(requestOptions?.headers).get('x-api-key')).toBe('fixture-serper-key');
    expect(JSON.parse(String(requestOptions?.body))).toEqual({
      q: '"LW4570"',
      gl: 'au',
      hl: 'en',
      num: 20,
    });
    expect(outcome).toMatchObject({
      state: 'ok',
      provider: 'serper-shopping-au',
      selectedProduct: { title: 'LW4570' },
      band: {
        lowestCents: 12_900,
        medianCents: 12_900,
        highestCents: 12_900,
      },
    });
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({
      itemPriceCents: 12_900,
      shippingCents: 0,
      comparisonPriceCents: 12_900,
      sourceDomain: 'shop.example.test',
      url: 'https://shop.example.test/locks/lockwood-001',
    });
  });

  it('mints an eBay application token and searches the EBAY_AU Browse API', async () => {
    const calls: { url: string; options: RequestInit | undefined }[] = [];
    const provider = createEbayBrowseProvider(
      {
        EBAY_CLIENT_ID: 'fixture-client-id',
        EBAY_CLIENT_SECRET: 'fixture-client-secret',
        EBAY_MARKETPLACE_ID: 'EBAY_AU',
      },
      async (url: string | URL | Request, options?: RequestInit) => {
        calls.push({ url: String(url), options });
        if (String(url).includes('/identity/v1/oauth2/token')) {
          return jsonResponse({
            access_token: 'fixture-application-token',
            expires_in: 7_200,
            token_type: 'Application Access Token',
          });
        }
        return jsonResponse({
          itemSummaries: [
            {
              title: 'New Lockwood 001 Deadlatch',
              price: { value: '149.95', currency: 'AUD' },
              itemWebUrl: 'https://www.ebay.com.au/itm/123456789',
              seller: { username: 'synthetic-ebay-seller' },
              condition: 'New',
              shippingOptions: [{ shippingCost: { value: '0.00', currency: 'AUD' } }],
            },
          ],
        });
      },
      () => Date.parse('2026-08-12T00:00:00.000Z'),
    );
    const outcome = await createSearchService({
      provider,
      clock: () => '2026-08-12T00:00:00.000Z',
    }).search('Lockwood 001');

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://api.ebay.com/identity/v1/oauth2/token');
    const tokenHeaders = new Headers(calls[0]?.options?.headers);
    expect(tokenHeaders.get('authorization')).toBe(
      `Basic ${Buffer.from('fixture-client-id:fixture-client-secret').toString('base64')}`,
    );
    expect(String(calls[0]?.options?.body)).toContain('grant_type=client_credentials');
    const browseUrl = new URL(calls[1]!.url);
    expect(browseUrl.origin + browseUrl.pathname).toBe(
      'https://api.ebay.com/buy/browse/v1/item_summary/search',
    );
    expect(browseUrl.searchParams.get('q')).toBe('Lockwood 001');
    const browseHeaders = new Headers(calls[1]?.options?.headers);
    expect(browseHeaders.get('authorization')).toBe('Bearer fixture-application-token');
    expect(browseHeaders.get('x-ebay-c-marketplace-id')).toBe('EBAY_AU');
    expect(outcome).toMatchObject({
      state: 'ok',
      provider: 'ebay-browse-au',
      band: {
        lowestCents: 14_995,
        medianCents: 14_995,
        highestCents: 14_995,
      },
    });
  });

  it('selects configured providers explicitly or by no-app-budget priority', () => {
    expect(
      createProviderFromEnvironment({
        SWL_SEARCH_PROVIDER: 'serper',
        SERPER_API_KEY: 'fixture-serper-key',
      }).name,
    ).toBe('serper-shopping-au');
    expect(
      createProviderFromEnvironment({
        EBAY_CLIENT_ID: 'fixture-client-id',
        EBAY_CLIENT_SECRET: 'fixture-client-secret',
      }).name,
    ).toBe('ebay-browse-au');
    expect(
      createProviderFromEnvironment({
        SWL_SEARCH_PROVIDER: 'serper',
        SERPER_API_KEY: 'replace_with_serper_api_key',
      }).configured,
    ).toBe(false);
    expect(() => createProviderFromEnvironment({ SWL_SEARCH_PROVIDER: 'unsupported' })).toThrow(
      /serpapi, serper or ebay/u,
    );

    const status = optionalProviderRegistry({
      SERPER_API_KEY: 'fixture-serper-key',
      EBAY_CLIENT_ID: 'fixture-client-id',
      EBAY_CLIENT_SECRET: 'fixture-client-secret',
    });
    expect(
      status.find((item: { name: string }) => item.name === 'serper-shopping-au')?.configured,
    ).toBe(true);
    expect(
      status.find((item: { name: string }) => item.name === 'ebay-browse-au')?.configured,
    ).toBe(true);
  });

  it('rejects redirects, non-JSON, oversized and malformed Serper responses', async () => {
    const cases: Array<{ response: Response; message: RegExp }> = [
      {
        response: new Response('', {
          status: 302,
          headers: { location: 'https://redirect.example.test' },
        }),
        message: /redirect rejected/u,
      },
      {
        response: new Response('not JSON', {
          headers: { 'content-type': 'text/plain' },
        }),
        message: /content type is not JSON/u,
      },
      {
        response: new Response('{}', {
          headers: {
            'content-type': 'application/json',
            'content-length': String(MAX_FREE_PROVIDER_RESPONSE_BYTES + 1),
          },
        }),
        message: /response size/u,
      },
      {
        response: new Response('{', {
          headers: { 'content-type': 'application/json' },
        }),
        message: /response JSON is invalid/u,
      },
    ];

    for (const testCase of cases) {
      let redirect: RequestRedirect | undefined;
      const provider = createSerperShoppingProvider(
        { SERPER_API_KEY: 'fixture-serper-key' },
        async (_url: string | URL | Request, options?: RequestInit) => {
          redirect = options?.redirect;
          return testCase.response;
        },
      );
      await expect(provider.search('LW4570')).rejects.toThrow(testCase.message);
      expect(redirect).toBe('manual');
    }
  });

  it('rejects an invalid eBay OAuth token and reuses a valid unexpired token', async () => {
    const invalid = createEbayBrowseProvider(
      {
        EBAY_CLIENT_ID: 'fixture-client-id',
        EBAY_CLIENT_SECRET: 'fixture-client-secret',
        EBAY_MARKETPLACE_ID: 'EBAY_AU',
      },
      async () => jsonResponse({ access_token: 'token', expires_in: 0 }),
    );
    await expect(invalid.search('LW4570')).rejects.toThrow(/OAuth token response is invalid/u);

    let tokenCalls = 0;
    let browseCalls = 0;
    const valid = createEbayBrowseProvider(
      {
        EBAY_CLIENT_ID: 'fixture-client-id',
        EBAY_CLIENT_SECRET: 'fixture-client-secret',
        EBAY_MARKETPLACE_ID: 'EBAY_AU',
      },
      async (url: string | URL | Request) => {
        if (String(url).includes('/identity/v1/oauth2/token')) {
          tokenCalls += 1;
          return jsonResponse({
            access_token: 'fixture-application-token',
            expires_in: 7_200,
          });
        }
        browseCalls += 1;
        return jsonResponse({ itemSummaries: [] });
      },
      () => Date.parse('2026-08-12T00:00:00.000Z'),
    );

    await valid.search('LW4570');
    await valid.search('LW4570');
    expect(tokenCalls).toBe(1);
    expect(browseCalls).toBe(2);
  });

  it('keeps only safe AUD eBay offers and excludes unknown delivered totals', async () => {
    const provider = createEbayBrowseProvider(
      {
        EBAY_CLIENT_ID: 'fixture-client-id',
        EBAY_CLIENT_SECRET: 'fixture-client-secret',
        EBAY_MARKETPLACE_ID: 'EBAY_AU',
      },
      async (url: string | URL | Request) =>
        String(url).includes('/identity/v1/oauth2/token')
          ? jsonResponse({
              access_token: 'fixture-application-token',
              expires_in: 7_200,
            })
          : jsonResponse({
              itemSummaries: [
                {
                  title: 'USD lock',
                  price: { value: '50.00', currency: 'USD' },
                  itemWebUrl: 'https://shop.example.test/usd',
                },
                {
                  title: 'Unsafe link lock',
                  price: { value: '75.00', currency: 'AUD' },
                  itemWebUrl: 'https://user:password@shop.example.test/unsafe',
                },
                {
                  title: 'Unknown delivery lock',
                  price: { value: '100.00', currency: 'AUD' },
                  itemWebUrl: 'https://shop.example.test/unknown-delivery',
                  seller: { username: 'synthetic-seller' },
                  condition: 'New',
                },
                {
                  title: 'Delivered lock',
                  price: { value: '125.00', currency: 'AUD' },
                  itemWebUrl: 'https://shop.example.test/delivered#fragment',
                  seller: { username: 'synthetic-seller' },
                  condition: 'New',
                  shippingOptions: [{ shippingCost: { value: '10.00', currency: 'AUD' } }],
                },
              ],
            }),
    );

    const response = await provider.search('LW4570');
    expect(response.offers).toHaveLength(2);
    expect(response.offers[0]).toMatchObject({
      title: 'Unknown delivery lock',
      comparisonEligible: false,
      comparisonPriceCents: null,
      exclusionReasons: ['delivered-total-unavailable'],
    });
    expect(response.offers[1]).toMatchObject({
      title: 'Delivered lock',
      comparisonEligible: true,
      comparisonPriceCents: 13_500,
      url: 'https://shop.example.test/delivered',
    });
  });
});
