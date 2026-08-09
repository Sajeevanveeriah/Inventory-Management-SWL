// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createFixtureProvider } from "../server/search/fixtureProvider.mjs";
import {
  createSerpApiProvider,
  MAX_PROVIDER_RESPONSE_BYTES,
} from "../server/search/serpapiProvider.mjs";
import {
  createPaidCallBudgetFromEnvironment,
  createRateLimiter,
  createSearchCache,
  createSearchService,
  priceBandCents,
} from "../server/search/service.mjs";
import {
  buildProviderQuery,
  classifyQuery,
} from "../server/search/normaliseQuery.mjs";

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
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function validProviderResult(overrides: Record<string, unknown> = {}) {
  return {
    title: "Synthetic lock",
    priceCents: 10_000,
    gstBasis: "unknown",
    packSize: null,
    seller: "Synthetic seller",
    sourceDomain: "shop.example.test",
    url: "https://shop.example.test/product/lock",
    ...overrides,
  };
}

describe("live search integration against the fixture provider (offline, no key)", () => {
  it("returns a successful multi-source result with band, coverage and timestamps", async () => {
    const outcome = await fixtureService().search("LW4570");
    expect(outcome.state).toBe("ok");
    expect(outcome.queryKind).toBe("identifier");
    expect(outcome.results.length).toBeGreaterThanOrEqual(3);
    expect(outcome.coverage.sourcesWithPrice).toBeGreaterThanOrEqual(3);
    for (const result of outcome.results) {
      expect(result.title).toBeTruthy();
      expect(result.priceAud).toMatch(/^\d+\.\d{2}$/);
      expect(result.currency).toBe("AUD");
      expect(["inc-gst", "ex-gst", "unknown"]).toContain(result.gstBasis);
      expect(result.sourceDomain).toBeTruthy();
      expect(result.url).toMatch(/^https:\/\//);
      expect(result.retrievedAt).toBeTruthy();
    }
    expect(outcome.band).not.toBeNull();
    expect(outcome.band.lowestCents).toBeLessThanOrEqual(
      outcome.band.medianCents,
    );
    expect(outcome.band.medianCents).toBeLessThanOrEqual(
      outcome.band.highestCents,
    );
  });

  it('reports zero results as the distinct "empty" state', async () => {
    const outcome = await fixtureService().search("fixture-none");
    expect(outcome.state).toBe("empty");
    expect(outcome.results).toEqual([]);
    expect(outcome.band).toBeNull();
  });

  it('reports a provider timeout as the distinct "timeout" state', async () => {
    const outcome = await fixtureService().search("fixture-timeout");
    expect(outcome.state).toBe("timeout");
    expect(outcome.results).toEqual([]);
  });

  it('reports a provider error as the distinct "provider_error" state', async () => {
    const outcome = await fixtureService().search("fixture-error");
    expect(outcome.state).toBe("provider_error");
    expect(outcome.detail).toContain("HTTP 500");
  });

  it('reports quota exhaustion as the distinct "quota_exhausted" state', async () => {
    const outcome = await fixtureService().search("fixture-quota");
    expect(outcome.state).toBe("quota_exhausted");
  });

  it('reports a missing API key as "not_configured" without crashing', async () => {
    const service = createSearchService({
      provider: createSerpApiProvider({}),
    });
    const outcome = await service.search("LW4570");
    expect(outcome.state).toBe("not_configured");
    expect(outcome.detail).toContain("provider credential");
  });

  it("honours the internal timeout with a slow provider", async () => {
    const service = createSearchService({
      provider: createFixtureProvider({ slowMs: 500 }),
      timeoutMs: 50,
    });
    const outcome = await service.search("fixture-slow");
    expect(outcome.state).toBe("timeout");
  });
});

describe("SerpAPI transport and response boundary", () => {
  it("uses only the exact HTTPS provider host, manual redirects and bounded JSON", async () => {
    let requestUrl = "";
    let requestOptions: RequestInit | undefined;
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: "synthetic-placeholder" },
      async (url: string | URL | Request, options?: RequestInit) => {
        requestUrl = String(url);
        requestOptions = options;
        return jsonResponse({
          shopping_results: [
            {
              title: "Synthetic lock",
              extracted_price: 95,
              source: "Synthetic seller",
              link: "https://shop.example.test/product/lock",
            },
          ],
        });
      },
    );
    expect(await provider.search("synthetic lock")).toEqual([
      validProviderResult({ priceCents: 9_500 }),
    ]);
    const parsed = new URL(requestUrl);
    expect(parsed.protocol).toBe("https:");
    expect(parsed.hostname).toBe("serpapi.com");
    expect(requestOptions?.redirect).toBe("manual");
  });

  it("rejects a redirect without following its target", async () => {
    let calls = 0;
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: "synthetic-placeholder" },
      async () => {
        calls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://unapproved.example.test/collect" },
        });
      },
    );
    await expect(provider.search("synthetic lock")).rejects.toThrow(
      "redirect rejected",
    );
    expect(calls).toBe(1);
  });

  it("rejects declared and streamed responses above the byte ceiling", async () => {
    const declared = createSerpApiProvider(
      { SERPAPI_KEY: "synthetic-placeholder" },
      async () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1),
          },
        }),
    );
    await expect(declared.search("synthetic lock")).rejects.toThrow(
      "response size",
    );

    const streamed = createSerpApiProvider(
      { SERPAPI_KEY: "synthetic-placeholder" },
      async () =>
        new Response(
          `{"padding":"${"x".repeat(MAX_PROVIDER_RESPONSE_BYTES)}"}`,
          { headers: { "content-type": "application/json" } },
        ),
    );
    await expect(streamed.search("synthetic lock")).rejects.toThrow(
      "response size",
    );
  });

  it("deterministically drops malformed provider items before the shared result boundary", async () => {
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: "synthetic-placeholder" },
      async () =>
        jsonResponse({
          shopping_results: [
            {
              title: "Synthetic lock",
              extracted_price: 95,
              source: "Synthetic seller",
              link: "https://shop.example.test/product/lock",
            },
            {
              title: "Credential URL",
              extracted_price: 95,
              source: "Bad seller",
              link: "https://user:pass@shop.example.test/product/lock",
            },
            {
              title: "Oversized price",
              price: "$10000000.01",
              source: "Bad seller",
              link: "https://shop.example.test/product/lock",
            },
          ],
        }),
    );
    expect(await provider.search("synthetic lock")).toEqual([
      validProviderResult({ priceCents: 9_500 }),
    ]);
  });
});

describe("shared provider-result validation", () => {
  function serviceFor(result: unknown) {
    return createSearchService({
      provider: {
        name: "synthetic-provider",
        configured: true,
        requiresPaidCall: false,
        async search() {
          return result;
        },
      },
    });
  }

  it.each([
    [
      "unknown full-row field",
      [validProviderResult({ supplierCostCents: 9_000 })],
    ],
    [
      "secret field",
      [validProviderResult({ apiKey: "synthetic-placeholder" })],
    ],
    [
      "price outside the product maximum",
      [validProviderResult({ priceCents: 1_000_000_001 })],
    ],
    ["oversized text", [validProviderResult({ title: "x".repeat(1_001) })]],
    [
      "credential URL",
      [validProviderResult({ url: "https://u:p@shop.example.test/x" })],
    ],
    [
      "non-HTTPS URL",
      [validProviderResult({ url: "http://shop.example.test/x" })],
    ],
    [
      "source host mismatch",
      [validProviderResult({ sourceDomain: "other.example.test" })],
    ],
    [
      "too many results",
      Array.from({ length: 101 }, () => validProviderResult()),
    ],
  ])(
    "returns provider_error for %s without exposing a result",
    async (_case, result) => {
      expect(await serviceFor(result).search("synthetic lock")).toMatchObject({
        state: "provider_error",
        results: [],
      });
    },
  );

  it("rejects oversized and control-character queries before any provider call", async () => {
    let calls = 0;
    const service = createSearchService({
      provider: {
        name: "synthetic-provider",
        configured: true,
        requiresPaidCall: false,
        async search() {
          calls += 1;
          return [validProviderResult()];
        },
      },
    });
    expect(await service.search("x".repeat(513))).toMatchObject({
      state: "invalid_query",
    });
    expect(await service.search("lock\u0000query")).toMatchObject({
      state: "invalid_query",
    });
    expect(calls).toBe(0);
  });
});

describe("rate limiting and caching", () => {
  it("limits outbound provider calls and reports rate_limited distinctly", async () => {
    const service = fixtureService({
      rateLimiter: createRateLimiter({ capacity: 2 }),
    });
    expect((await service.search("query one")).state).toBe("ok");
    expect((await service.search("query two")).state).toBe("ok");
    const third = await service.search("query three");
    expect(third.state).toBe("rate_limited");
  });

  it("serves repeat queries from cache with the original retrieval timestamp", async () => {
    let t = 0;
    const service = fixtureService({
      cache: createSearchCache({ now: () => t }),
      clock: () => "2026-08-05T00:00:00.000Z",
    });
    const first = await service.search("AB9053");
    t = 60_000;
    const second = await service.search("AB9053");
    expect(second.cached).toBe(true);
    expect(second.retrievedAt).toBe(first.retrievedAt);
  });
});

describe("paid provider cost ceiling", () => {
  function paidProvider(onCall: () => void) {
    return {
      name: "synthetic-paid-provider",
      configured: true,
      requiresPaidCall: true,
      async search(query: string) {
        onCall();
        return [
          {
            title: `Synthetic result ${query}`,
            priceCents: 10_000,
            gstBasis: "unknown",
            packSize: null,
            seller: "Synthetic seller",
            sourceDomain: "example.test",
            url: "https://example.test/product",
          },
        ];
      },
    };
  }

  it("refuses paid network calls by default even when a credential-configured provider exists", async () => {
    let calls = 0;
    const budget = createPaidCallBudgetFromEnvironment({});
    const service = createSearchService({
      provider: paidProvider(() => {
        calls += 1;
      }),
      paidCallBudget: budget,
    });
    expect(await service.search("LW4570")).toMatchObject({
      state: "not_configured",
    });
    expect(calls).toBe(0);
    expect(budget.status()).toMatchObject({
      state: "disabled",
      ceilingCents: 0,
    });
  });

  it("fails closed when any mandatory paid-call budget setting is missing or malformed", async () => {
    let calls = 0;
    const budget = createPaidCallBudgetFromEnvironment({
      SWL_PAID_CALLS_ENABLED: "true",
      SWL_PROVIDER_COST_CEILING_CENTS: "100",
    });
    const service = createSearchService({
      provider: paidProvider(() => {
        calls += 1;
      }),
      paidCallBudget: budget,
    });
    expect(budget.status().state).toBe("invalid");
    expect(await service.search("LW4570")).toMatchObject({
      state: "not_configured",
    });
    expect(calls).toBe(0);
  });

  it("reserves the declared per-call cost and refuses calls beyond the explicit ceiling", async () => {
    let calls = 0;
    const budget = createPaidCallBudgetFromEnvironment({
      SWL_PAID_CALLS_ENABLED: "true",
      SWL_PROVIDER_COST_CEILING_CENTS: "10",
      SWL_PROVIDER_COST_PER_CALL_CENTS: "5",
    });
    const service = createSearchService({
      provider: paidProvider(() => {
        calls += 1;
      }),
      paidCallBudget: budget,
    });
    expect((await service.search("paid one")).state).toBe("ok");
    expect((await service.search("paid two")).state).toBe("ok");
    expect(await service.search("paid three")).toMatchObject({
      state: "quota_exhausted",
    });
    expect(calls).toBe(2);
    expect(budget.status()).toMatchObject({
      state: "exhausted",
      reservedCents: 10,
    });
  });

  it("keeps the deterministic fixture exempt from paid-call reservations", async () => {
    const budget = createPaidCallBudgetFromEnvironment({});
    const outcome = await createSearchService({
      provider: createFixtureProvider(),
      paidCallBudget: budget,
    }).search("LW4570");
    expect(outcome.state).toBe("ok");
    expect(budget.status()).toMatchObject({
      state: "disabled",
      reservedCents: 0,
    });
  });
});

describe("query normalisation and classification", () => {
  it("detects identifiers, barcodes and free text without a type selector", () => {
    expect(classifyQuery("lw4570")).toBe("identifier");
    expect(classifyQuery("9312345678907")).toBe("barcode");
    expect(classifyQuery("lockwood deadlatch satin chrome")).toBe("free-text");
    expect(classifyQuery("")).toBe("empty");
  });
  it("quotes identifiers for the provider and passes free text through", () => {
    expect(buildProviderQuery("  LW4570 ").providerQuery).toBe('"LW4570"');
    expect(buildProviderQuery("lockwood  deadlatch").providerQuery).toBe(
      "lockwood deadlatch",
    );
  });
});

describe("price band in integer cents", () => {
  it("computes lowest, median and highest with half-up integer median", () => {
    const band = priceBandCents([
      { priceCents: 12995 },
      { priceCents: 14350 },
      { priceCents: 13900 },
      { priceCents: 26500 },
    ]);
    expect(band.lowest).toBe("129.95");
    expect(band.median).toBe("141.25");
    expect(band.highest).toBe("265.00");
    expect(band.pricedResults).toBe(4);
  });
});
