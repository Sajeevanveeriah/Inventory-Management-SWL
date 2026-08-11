// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEbayBrowseProvider } from "../server/search/ebayBrowseProvider.mjs";
import {
  createProviderFromEnvironment,
  optionalProviderRegistry,
} from "../server/search/providerRegistry.mjs";
import { createSerperShoppingProvider } from "../server/search/serperShoppingProvider.mjs";
import { createSearchService } from "../server/search/service.mjs";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("zero-cost competitor provider adapters", () => {
  it("uses a Serper key from the environment and returns direct AUD offers", async () => {
    let requestUrl = "";
    let requestOptions: RequestInit | undefined;
    const provider = createSerperShoppingProvider(
      { SERPER_API_KEY: "synthetic-serper-key" },
      async (url: string | URL | Request, options?: RequestInit) => {
        requestUrl = String(url);
        requestOptions = options;
        return jsonResponse({
          shopping: [
            {
              title: "Lockwood 001 Double Cylinder Deadlatch - New",
              source: "Synthetic Locksmith Supply",
              link: "https://shop.example.test/locks/lockwood-001#offer",
              price: "A$129.00",
              extractedPrice: 129,
              delivery: "Free delivery",
              availability: "In stock",
            },
          ],
        });
      },
    );
    const outcome = await createSearchService({
      provider,
      clock: () => "2026-08-12T00:00:00.000Z",
    }).search("LW4570");

    expect(requestUrl).toBe("https://google.serper.dev/shopping");
    expect(new Headers(requestOptions?.headers).get("x-api-key")).toBe(
      "synthetic-serper-key",
    );
    expect(JSON.parse(String(requestOptions?.body))).toEqual({
      q: '"LW4570"',
      gl: "au",
      hl: "en",
      num: 20,
    });
    expect(outcome).toMatchObject({
      state: "ok",
      provider: "serper-shopping-au",
      selectedProduct: { title: "LW4570" },
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
      sourceDomain: "shop.example.test",
      url: "https://shop.example.test/locks/lockwood-001",
    });
  });

  it("mints an eBay application token and searches the EBAY_AU Browse API", async () => {
    const calls: { url: string; options: RequestInit | undefined }[] = [];
    const provider = createEbayBrowseProvider(
      {
        EBAY_CLIENT_ID: "synthetic-client-id",
        EBAY_CLIENT_SECRET: "synthetic-client-secret",
        EBAY_MARKETPLACE_ID: "EBAY_AU",
      },
      async (url: string | URL | Request, options?: RequestInit) => {
        calls.push({ url: String(url), options });
        if (String(url).includes("/identity/v1/oauth2/token")) {
          return jsonResponse({
            access_token: "synthetic-application-token",
            expires_in: 7_200,
            token_type: "Application Access Token",
          });
        }
        return jsonResponse({
          itemSummaries: [
            {
              title: "New Lockwood 001 Deadlatch",
              price: { value: "149.95", currency: "AUD" },
              itemWebUrl: "https://www.ebay.com.au/itm/123456789",
              seller: { username: "synthetic-ebay-seller" },
              condition: "New",
              shippingOptions: [
                { shippingCost: { value: "0.00", currency: "AUD" } },
              ],
            },
          ],
        });
      },
      () => Date.parse("2026-08-12T00:00:00.000Z"),
    );
    const outcome = await createSearchService({
      provider,
      clock: () => "2026-08-12T00:00:00.000Z",
    }).search("Lockwood 001");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://api.ebay.com/identity/v1/oauth2/token");
    const tokenHeaders = new Headers(calls[0]?.options?.headers);
    expect(tokenHeaders.get("authorization")).toBe(
      `Basic ${Buffer.from("synthetic-client-id:synthetic-client-secret").toString("base64")}`,
    );
    expect(String(calls[0]?.options?.body)).toContain(
      "grant_type=client_credentials",
    );
    const browseUrl = new URL(calls[1]!.url);
    expect(browseUrl.origin + browseUrl.pathname).toBe(
      "https://api.ebay.com/buy/browse/v1/item_summary/search",
    );
    expect(browseUrl.searchParams.get("q")).toBe("Lockwood 001");
    const browseHeaders = new Headers(calls[1]?.options?.headers);
    expect(browseHeaders.get("authorization")).toBe(
      "Bearer synthetic-application-token",
    );
    expect(browseHeaders.get("x-ebay-c-marketplace-id")).toBe("EBAY_AU");
    expect(outcome).toMatchObject({
      state: "ok",
      provider: "ebay-browse-au",
      band: {
        lowestCents: 14_995,
        medianCents: 14_995,
        highestCents: 14_995,
      },
    });
  });

  it("selects configured providers explicitly or by zero-cost priority", () => {
    expect(
      createProviderFromEnvironment({
        SWL_SEARCH_PROVIDER: "serper",
        SERPER_API_KEY: "synthetic-serper-key",
      }).name,
    ).toBe("serper-shopping-au");
    expect(
      createProviderFromEnvironment({
        EBAY_CLIENT_ID: "synthetic-client-id",
        EBAY_CLIENT_SECRET: "synthetic-client-secret",
      }).name,
    ).toBe("ebay-browse-au");
    expect(
      createProviderFromEnvironment({
        SWL_SEARCH_PROVIDER: "serper",
        SERPER_API_KEY: "replace_with_serper_api_key",
      }).configured,
    ).toBe(false);
    expect(() =>
      createProviderFromEnvironment({ SWL_SEARCH_PROVIDER: "unsupported" }),
    ).toThrow(/serpapi, serper or ebay/u);

    const status = optionalProviderRegistry({
      SERPER_API_KEY: "synthetic-serper-key",
      EBAY_CLIENT_ID: "synthetic-client-id",
      EBAY_CLIENT_SECRET: "synthetic-client-secret",
    });
    expect(
      status.find(
        (item: { name: string }) => item.name === "serper-shopping-au",
      )?.configured,
    ).toBe(true);
    expect(
      status.find((item: { name: string }) => item.name === "ebay-browse-au")
        ?.configured,
    ).toBe(true);
  });
});
