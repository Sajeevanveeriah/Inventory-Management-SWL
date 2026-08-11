import type { Page } from "@playwright/test";

const RETRIEVED_AT = "2026-08-11T00:00:00.000Z";
const CANDIDATE_TOKEN = "test-only-product-candidate";

function base(query: string) {
  return {
    query,
    queryKind: "identifier",
    provider: "serpapi-google-shopping-au",
    candidates: [],
    results: [],
    band: null,
    retrievedAt: RETRIEVED_AT,
    cached: false,
  };
}

function coverage(overrides: Record<string, unknown> = {}) {
  return {
    providerQueried: "serpapi-google-shopping-au",
    sourcesWithPrice: 0,
    sourceDomains: [],
    pricedResults: 0,
    providerCandidates: 0,
    parsedOffers: 0,
    comparableOffers: 0,
    excludedOffers: 0,
    ...overrides,
  };
}

/** Test-only network boundary. Production code never imports this module. */
export async function installLiveSearchApiMock(page: Page) {
  await page.route("**/api/health", async (route) => {
    await route.fulfill({
      json: {
        ok: true,
        provider: "serpapi-google-shopping-au",
        liveSearchConfigured: true,
        fixtureMode: false,
        paidCallsEnabled: true,
        costCeilingAud: "10.00",
        costCeilingCents: 1_000,
        costPerCallCents: 5,
        spentCents: 0,
        schemaVersion: 2,
      },
    });
  });
  await page.route("**/api/competitor-search", async (route) => {
    const body = route.request().postDataJSON() as {
      query: string;
      candidateToken?: string;
    };
    if (body.query.startsWith("fixture-slow")) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (body.query === "fixture-none") {
      await route.fulfill({
        json: {
          ...base(body.query),
          state: "empty",
          detail: "No selectable product cluster was returned.",
          coverage: coverage(),
        },
      });
      return;
    }
    if (body.query === "fixture-error") {
      await route.fulfill({
        json: {
          ...base(body.query),
          state: "provider_error",
          detail: "Test-only provider error state.",
        },
      });
      return;
    }
    if (body.query === "fixture-quota") {
      await route.fulfill({
        json: {
          ...base(body.query),
          state: "quota_exhausted",
          detail: "Test-only provider quota state.",
        },
      });
      return;
    }
    if (body.candidateToken === undefined) {
      await route.fulfill({
        json: {
          ...base(body.query),
          state: "selection_required",
          candidates: [
            {
              token: CANDIDATE_TOKEN,
              title: "Lockwood 4570 mortice lock",
              brand: "Lockwood",
              productId: "4570",
              productUrl:
                "https://www.google.com.au/shopping/product/test-lockwood-4570",
              displayedPrice: "A$120.00",
              priceCents: 12_000,
              multipleSources: true,
              packSize: null,
              condition: "new",
              position: 1,
            },
          ],
          detail: "Choose the exact product candidate.",
          coverage: coverage({ providerCandidates: 1 }),
        },
      });
      return;
    }
    if (body.candidateToken !== CANDIDATE_TOKEN) {
      await route.fulfill({
        status: 422,
        json: { error: "Candidate rejected." },
      });
      return;
    }
    await route.fulfill({
      json: {
        ...base(body.query),
        state: "ok",
        selectedProduct: {
          title: "Lockwood 4570 mortice lock",
          brand: "Lockwood",
          productId: "4570",
        },
        results: [
          {
            searchQuery: body.query,
            selectedProductTitle: "Lockwood 4570 mortice lock",
            selectedProductBrand: "Lockwood",
            selectedProductId: "4570",
            title: "Lockwood 4570 mortice lock",
            priceCents: 12_000,
            priceAud: "120.00",
            itemPriceCents: 12_000,
            itemPriceAud: "120.00",
            shippingCents: 500,
            shippingAud: "5.00",
            estimatedTaxCents: null,
            estimatedTaxAud: null,
            totalPriceCents: 12_500,
            totalPriceAud: "125.00",
            comparisonPriceCents: 12_500,
            comparisonPriceAud: "125.00",
            priceBasis: "provider_total",
            originalPriceText: "A$120.00",
            currencyBasis: "explicit-aud",
            currency: "AUD",
            gstBasis: "unknown",
            packSize: null,
            condition: "new",
            availability: "in-stock",
            financing: false,
            comparisonEligible: true,
            exclusionReasons: [],
            seller: "Test-only merchant",
            sourceDomain: "merchant.example.test",
            url: "https://merchant.example.test/lockwood-4570",
            retrievedAt: RETRIEVED_AT,
          },
        ],
        band: {
          lowest: "125.00",
          median: "125.00",
          highest: "125.00",
          lowestCents: 12_500,
          medianCents: 12_500,
          highestCents: 12_500,
          pricedResults: 1,
        },
        coverage: coverage({
          sourcesWithPrice: 1,
          sourceDomains: ["merchant.example.test"],
          pricedResults: 1,
          parsedOffers: 1,
          comparableOffers: 1,
        }),
      },
    });
  });
}
