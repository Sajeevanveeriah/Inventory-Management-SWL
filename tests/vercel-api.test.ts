// @vitest-environment node
import { readFileSync } from "node:fs";
import { Redis, type Requester, type UpstashRequest } from "@upstash/redis";
import { describe, expect, it, vi } from "vitest";
import { accessTokenKey } from "../server/vercel/auth.mjs";
import { readVercelConfig } from "../server/vercel/config.mjs";
import {
  createCompetitorSearchHandler as createCompetitorSearchHandlerImpl,
  createHealthHandler as createHealthHandlerImpl,
} from "../server/vercel/handlers.mjs";
import {
  createRedisControls,
  requestCacheKey,
} from "../server/vercel/redisControls.mjs";
import { createSerpApiProvider } from "../server/search/serpapiProvider.mjs";
import { LiveSearchOutcomeSchema } from "../src/platform/schemas";

const origin = "https://sajeevanveeriah.github.io";
const token = "A".repeat(43);
const providerLocation = "Geelong, Victoria, Australia";
const otherProviderLocation = "Melbourne, Victoria, Australia";
const vercelTestClock = () => Date.parse("2026-08-15T00:00:00.000Z");

const selectedCandidate = Object.freeze({
  token: "candidate-token",
  title: "Used Lockwood 4570 mortice lock",
  brand: "Lockwood",
  productId: "4570",
  productUrl: "https://www.google.com/shopping/product/4570",
  displayedPrice: "$123.45",
  priceCents: 12_345,
  multipleSources: true,
  packSize: null,
  condition: "used",
  position: 1,
});

const cachedOutcome = Object.freeze({
  state: "selection_required",
  query: "LW4570",
  queryKind: "identifier",
  provider: "serpapi-google-shopping-au",
  candidates: [selectedCandidate],
  results: [],
  band: null,
  retrievedAt: "2026-08-11T07:00:00.000Z",
  cached: false,
  detail: "Select the exact product.",
  coverage: {
    providerQueried: "serpapi-google-shopping-au",
    sourcesWithPrice: 0,
    sourceDomains: [],
    pricedResults: 0,
    providerCandidates: 1,
    parsedOffers: 0,
    comparableOffers: 0,
    excludedOffers: 0,
  },
});

const cachedOfferOutcome = Object.freeze({
  state: "ok",
  query: "Lockwood 001",
  queryKind: "free-text",
  provider: "serpapi-google-shopping-au",
  candidates: [],
  selectedProduct: {
    title: "Lockwood 001 Double Cylinder Deadlatch",
    brand: "Lockwood",
    productId: "001",
  },
  results: [
    {
      title: "Lockwood 001 Double Cylinder Deadlatch",
      priceCents: 10_000,
      priceAud: "100.00",
      itemPriceCents: 10_000,
      itemPriceAud: "100.00",
      shippingCents: 1_000,
      shippingAud: "10.00",
      estimatedTaxCents: 0,
      estimatedTaxAud: "0.00",
      totalPriceCents: 11_000,
      totalPriceAud: "110.00",
      comparisonPriceCents: 11_000,
      comparisonPriceAud: "110.00",
      priceBasis: "provider_total",
      originalPriceText: "A$100.00",
      currencyBasis: "explicit-aud",
      currency: "AUD",
      gstBasis: "unknown",
      packSize: null,
      condition: "new",
      availability: "in-stock",
      financing: false,
      comparisonEligible: true,
      exclusionReasons: [],
      seller: "Merchant One",
      sourceDomain: "merchant-one.example.test",
      url: "https://merchant-one.example.test/products/lockwood-001",
      retrievedAt: "2026-08-11T07:00:00.000Z",
      searchQuery: "Lockwood 001",
      selectedProductTitle: "Lockwood 001 Double Cylinder Deadlatch",
      selectedProductBrand: "Lockwood",
      selectedProductId: "001",
    },
  ],
  band: {
    lowest: "110.00",
    median: "110.00",
    highest: "110.00",
    lowestCents: 11_000,
    medianCents: 11_000,
    highestCents: 11_000,
    pricedResults: 1,
  },
  retrievedAt: "2026-08-11T07:00:00.000Z",
  cached: false,
  detail: "",
  coverage: {
    providerQueried: "serpapi-google-shopping-au",
    sourcesWithPrice: 1,
    sourceDomains: ["merchant-one.example.test"],
    pricedResults: 1,
    providerCandidates: 0,
    parsedOffers: 1,
    comparableOffers: 1,
    excludedOffers: 0,
  },
});

function runtime(overrides: Record<string, unknown> = {}) {
  const controls = {
    status: vi.fn(async () => ({ reservedCents: 25, providerCalls: 1 })),
    authorise: vi.fn(
      async (
        ...args: [string?, string?, unknown?]
      ): Promise<Record<string, unknown>> => {
        void args;
        return {
          state: "authorised",
          cached: null,
          owner: "lock-owner",
          lockKey: "swl:flight:one",
        };
      },
    ),
    selectCandidate: vi.fn(
      async (...args: [string?, string?]): Promise<Record<string, unknown>> => {
        void args;
        return {
          state: "selected",
          candidate: selectedCandidate,
          discoveryKey: requestCacheKey("LW4570", "", providerLocation),
          discoveryDigest: "1".repeat(40),
          providerLocation,
        };
      },
    ),
    complete: vi.fn(async (...args: unknown[]) => {
      void args;
    }),
    release: vi.fn(async (...args: unknown[]) => {
      void args;
    }),
  };
  const searchService = {
    search: vi.fn(
      async (
        query: string,
        ...args: [string?, unknown?]
      ): Promise<Record<string, unknown>> => {
        void args;
        return {
          state: "selection_required",
          query,
          queryKind: "identifier",
          provider: "serpapi-google-shopping-au",
          candidates: [
            {
              token: "candidate-token",
              title: "Lockwood 4570 mortice lock",
              brand: "Lockwood",
              productId: "4570",
              productUrl: "https://www.google.com/shopping/product/4570",
              displayedPrice: "$123.45",
              priceCents: 12_345,
              multipleSources: true,
              packSize: null,
              condition: "new",
              position: 1,
            },
          ],
          results: [],
          band: null,
          retrievedAt: "2026-08-11T07:00:00.000Z",
          cached: false,
          detail: "Select the exact product.",
          coverage: {
            providerQueried: "serpapi-google-shopping-au",
            sourcesWithPrice: 0,
            sourceDomains: [],
            pricedResults: 0,
            providerCandidates: 1,
            parsedOffers: 0,
            comparableOffers: 0,
            excludedOffers: 0,
          },
        };
      },
    ),
  };
  return {
    config: {
      frontendOrigin: origin,
      accessTokenPepper: "p".repeat(32),
      costCeilingCents: 1000,
      costPerCallCents: 25,
      budgetPeriod: "2026-08",
      budgetRetentionExpiresAtSeconds: 1_790_812_800,
      providerLocation,
      perUserPerMinute: 5,
      globalPerMinute: 10,
      cacheTtlSeconds: 900,
    },
    redis: {
      get: vi.fn(async (key?: string): Promise<unknown> => {
        void key;
        return {
          sub: "saj",
          enabled: true,
          expiresAt: "2030-01-01T00:00:00.000Z",
        };
      }),
    },
    provider: { name: "serpapi-google-shopping-au", configured: true },
    controls,
    searchService,
    ...overrides,
  };
}

function createCompetitorSearchHandler(
  getRuntime: () => Promise<ReturnType<typeof runtime>>,
  now = vercelTestClock,
) {
  return createCompetitorSearchHandlerImpl(getRuntime, now);
}

function createHealthHandler(
  getRuntime: () => Promise<ReturnType<typeof runtime>>,
  now = vercelTestClock,
) {
  return createHealthHandlerImpl(getRuntime, now);
}

function request(
  path: string,
  options: {
    method?: string;
    origin?: string | null;
    token?: string;
    body?: unknown;
    rawBody?: string;
    contentType?: string | null;
    preflightMethod?: string;
    preflightHeaders?: string;
  } = {},
) {
  const headers = new Headers();
  if (options.origin !== null) headers.set("origin", options.origin ?? origin);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (
    options.contentType !== null &&
    (options.body !== undefined || options.rawBody !== undefined)
  ) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  if (options.preflightMethod) {
    headers.set("access-control-request-method", options.preflightMethod);
  }
  if (options.preflightHeaders) {
    headers.set("access-control-request-headers", options.preflightHeaders);
  }
  const body =
    options.rawBody ??
    (options.body !== undefined ? JSON.stringify(options.body) : undefined);
  return new Request(`https://api.example.test${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(body !== undefined ? { body } : {}),
  });
}

function upstashRedisReturning(...replies: unknown[]) {
  const commands: unknown[][] = [];
  const requester: Requester = {
    async request<TResult = unknown>(request: UpstashRequest) {
      commands.push(
        Array.isArray(request.body) ? request.body : [request.body],
      );
      return { result: replies.shift() as TResult };
    },
  };
  return { redis: new Redis(requester), commands };
}

describe("API-only Vercel boundary", () => {
  it("permits preflight only for the exact Pages origin", async () => {
    const handler = createCompetitorSearchHandler(async () => runtime());
    expect(
      (
        await handler(
          request("/api/competitor-search", {
            method: "OPTIONS",
            preflightMethod: "POST",
            preflightHeaders: "authorization, content-type",
          }),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await handler(
          request("/api/competitor-search", {
            method: "OPTIONS",
            origin: "https://sajeevanveeriah.github.io.evil.test",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request("/api/competitor-search", {
            method: "OPTIONS",
            origin: null,
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request("/api/competitor-search", {
            method: "OPTIONS",
            preflightMethod: "GET",
            preflightHeaders: "authorization, content-type",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request("/api/competitor-search", {
            method: "OPTIONS",
            preflightMethod: "POST",
            preflightHeaders: "authorization, x-unapproved",
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("authenticates before rate, budget, cache or provider work", async () => {
    const value = runtime();
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        body: { query: "LW4570" },
      }),
    );
    expect(response.status).toBe(401);
    expect(value.controls.authorise).not.toHaveBeenCalled();
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it("rejects extra JSON keys before reserving a provider call", async () => {
    const value = runtime();
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570", unexpected: true },
      }),
    );
    expect(response.status).toBe(422);
    expect(value.controls.authorise).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "revoked",
      record: {
        sub: "saj",
        enabled: false,
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    },
    {
      name: "expired",
      record: {
        sub: "saj",
        enabled: true,
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
    },
  ])("rejects a $name token before search controls", async ({ record }) => {
    const value = runtime();
    value.redis.get.mockResolvedValue(record);
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570" },
      }),
    );
    expect(response.status).toBe(403);
    expect(value.controls.selectCandidate).not.toHaveBeenCalled();
    expect(value.controls.authorise).not.toHaveBeenCalled();
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it("serves a Redis cache hit without invoking or completing provider work", async () => {
    const value = runtime();
    value.controls.authorise.mockResolvedValue({
      state: "cache",
      cached: JSON.stringify(cachedOutcome),
      owner: "unused-owner",
      lockKey: "unused-lock",
    });
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ...cachedOutcome, cached: true });
    expect(LiveSearchOutcomeSchema.safeParse(body).success).toBe(true);
    expect(value.searchService.search).not.toHaveBeenCalled();
    expect(value.controls.complete).not.toHaveBeenCalled();
    expect(value.controls.release).not.toHaveBeenCalled();
  });

  it("fails closed rather than returning an invalid cached outcome shape", async () => {
    const value = runtime();
    value.controls.authorise.mockResolvedValue({
      state: "cache",
      cached: JSON.stringify({ state: "selection_required", cached: false }),
      owner: "unused-owner",
      lockKey: "unused-lock",
    });
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570" },
      }),
    );
    expect(response.status).toBe(503);
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "contradictory nested prices",
      corrupt(outcome: typeof cachedOfferOutcome) {
        outcome.results[0]!.comparisonPriceCents = 10_500;
        outcome.results[0]!.comparisonPriceAud = "105.00";
      },
    },
    {
      name: "a contradictory comparison band",
      corrupt(outcome: typeof cachedOfferOutcome) {
        outcome.band!.medianCents = 10_500;
        outcome.band!.median = "105.00";
      },
    },
    {
      name: "a mismatched source domain",
      corrupt(outcome: typeof cachedOfferOutcome) {
        outcome.results[0]!.sourceDomain = "other-merchant.example.test";
      },
    },
    {
      name: "a differently canonicalised source domain",
      corrupt(outcome: typeof cachedOfferOutcome) {
        outcome.results[0]!.sourceDomain = "merchant-one.example.test.";
        outcome.coverage!.sourceDomains = ["merchant-one.example.test."];
      },
    },
    {
      name: "a non-default merchant URL port",
      corrupt(outcome: typeof cachedOfferOutcome) {
        outcome.results[0]!.url =
          "https://merchant-one.example.test:444/products/lockwood-001";
      },
    },
    {
      name: "a Google Ads intermediary URL",
      corrupt(outcome: typeof cachedOfferOutcome) {
        outcome.results[0]!.sourceDomain = "googleadservices.com";
        outcome.results[0]!.url =
          "https://googleadservices.com/pagead/aclk?target=merchant";
        outcome.coverage!.sourceDomains = ["googleadservices.com"];
      },
    },
  ])("fails closed for $name in Redis", async ({ corrupt }) => {
    const outcome = structuredClone(cachedOfferOutcome);
    corrupt(outcome);
    const value = runtime();
    value.controls.authorise.mockResolvedValue({
      state: "cache",
      cached: JSON.stringify(outcome),
      owner: "unused-owner",
      lockKey: "unused-lock",
    });
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "Lockwood 001" },
      }),
    );
    expect(response.status).toBe(503);
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it.each(["user_rate", "global_rate", "budget"])(
    "maps %s denial to HTTP 429 without provider work",
    async (state) => {
      const value = runtime();
      value.controls.authorise.mockResolvedValue({
        state,
        cached: null,
        owner: "unused-owner",
        lockKey: "unused-lock",
      });
      const handler = createCompetitorSearchHandler(async () => value);
      const response = await handler(
        request("/api/competitor-search", {
          method: "POST",
          token,
          body: { query: "LW4570" },
        }),
      );
      expect(response.status).toBe(429);
      expect(value.searchService.search).not.toHaveBeenCalled();
      expect(value.controls.complete).not.toHaveBeenCalled();
      expect(value.controls.release).not.toHaveBeenCalled();
    },
  );

  it("returns 409 for an identical in-progress search without provider work", async () => {
    const value = runtime();
    value.controls.authorise.mockResolvedValue({
      state: "in_progress",
      cached: null,
      owner: "unused-owner",
      lockKey: "unused-lock",
    });
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570" },
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "search_in_progress" });
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it("fails closed when the token Redis lookup is unavailable", async () => {
    const value = runtime();
    value.redis.get.mockRejectedValue(new Error("synthetic Redis failure"));
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570" },
      }),
    );
    expect(response.status).toBe(503);
    expect(value.controls.selectCandidate).not.toHaveBeenCalled();
    expect(value.controls.authorise).not.toHaveBeenCalled();
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it("fails closed when Redis search controls are unavailable", async () => {
    const value = runtime();
    value.controls.authorise.mockRejectedValue(
      new Error("synthetic Redis failure"),
    );
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570" },
      }),
    );
    expect(response.status).toBe(503);
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it("retains the reservation and releases only the lock after provider failure", async () => {
    const value = runtime();
    value.searchService.search.mockRejectedValue(
      new Error("synthetic provider failure"),
    );
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570" },
      }),
    );
    expect(response.status).toBe(502);
    expect(value.controls.complete).not.toHaveBeenCalled();
    expect(value.controls.release).toHaveBeenCalledOnce();
    expect(value.controls.release).toHaveBeenCalledWith(
      "swl:flight:one",
      "lock-owner",
    );
    expect(value.controls.status).not.toHaveBeenCalled();
  });

  it("releases the lock without refunding when the service reports provider failure", async () => {
    const value = runtime();
    value.searchService.search.mockResolvedValue({
      state: "provider_error",
      query: "LW4570",
      queryKind: "identifier",
      provider: "serpapi-google-shopping-au",
      candidates: [],
      results: [],
      band: null,
      detail: "The provider rejected the request.",
    });
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570" },
      }),
    );
    expect(response.status).toBe(200);
    expect(value.controls.complete).not.toHaveBeenCalled();
    expect(value.controls.release).toHaveBeenCalledWith(
      "swl:flight:one",
      "lock-owner",
    );
    expect(value.controls.status).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "wrong method",
      options: { method: "GET", token },
      status: 405,
    },
    {
      name: "missing content type",
      options: {
        method: "POST",
        token,
        rawBody: JSON.stringify({ query: "LW4570" }),
        contentType: null,
      },
      status: 415,
    },
    {
      name: "wrong content type",
      options: {
        method: "POST",
        token,
        rawBody: JSON.stringify({ query: "LW4570" }),
        contentType: "text/plain",
      },
      status: 415,
    },
    {
      name: "invalid JSON",
      options: { method: "POST", token, rawBody: "{" },
      status: 400,
    },
    {
      name: "array body",
      options: { method: "POST", token, body: [] },
      status: 400,
    },
    {
      name: "empty query",
      options: { method: "POST", token, body: { query: "" } },
      status: 422,
    },
    {
      name: "untrimmed query",
      options: { method: "POST", token, body: { query: " LW4570" } },
      status: 422,
    },
    {
      name: "oversized query",
      options: { method: "POST", token, body: { query: "q".repeat(513) } },
      status: 422,
    },
    {
      name: "control character",
      options: { method: "POST", token, body: { query: "LW\u00004570" } },
      status: 422,
    },
    {
      name: "empty candidate",
      options: {
        method: "POST",
        token,
        body: { query: "LW4570", candidateToken: "" },
      },
      status: 422,
    },
    {
      name: "oversized candidate",
      options: {
        method: "POST",
        token,
        body: { query: "LW4570", candidateToken: "c".repeat(8193) },
      },
      status: 422,
    },
    {
      name: "oversized body",
      options: {
        method: "POST",
        token,
        rawBody: JSON.stringify({ query: "q", padding: "x".repeat(17_000) }),
      },
      status: 413,
    },
  ])("strictly rejects $name before controls", async ({ options, status }) => {
    const value = runtime();
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(request("/api/competitor-search", options));
    expect(response.status).toBe(status);
    expect(value.controls.selectCandidate).not.toHaveBeenCalled();
    expect(value.controls.authorise).not.toHaveBeenCalled();
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it("returns a real-provider candidate response and caches the sanitised outcome", async () => {
    const value = runtime();
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "selection_required",
      provider: "serpapi-google-shopping-au",
    });
    expect(value.searchService.search).toHaveBeenCalledWith(
      "LW4570",
      undefined,
    );
    expect(value.controls.complete).toHaveBeenCalledTimes(1);
  });

  it("validates a selected candidate from discovery before reservation and passes it to search", async () => {
    const value = runtime();
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570", candidateToken: "candidate-token" },
      }),
    );
    expect(response.status).toBe(200);
    expect(value.controls.selectCandidate).toHaveBeenCalledWith(
      "LW4570",
      "candidate-token",
    );
    expect(value.controls.authorise).toHaveBeenCalledWith(
      "saj",
      requestCacheKey("LW4570", "candidate-token", providerLocation),
      {
        discoveryKey: requestCacheKey("LW4570", "", providerLocation),
        discoveryDigest: "1".repeat(40),
        providerLocation,
      },
    );
    expect(value.searchService.search).toHaveBeenCalledWith(
      "LW4570",
      "candidate-token",
      selectedCandidate,
    );
  });

  it.each(["missing", "invalid"])(
    "fails a %s discovery selection before rate, budget or provider work",
    async (state) => {
      const value = runtime();
      value.controls.selectCandidate.mockResolvedValue({ state });
      const handler = createCompetitorSearchHandler(async () => value);
      const response = await handler(
        request("/api/competitor-search", {
          method: "POST",
          token,
          body: { query: "LW4570", candidateToken: "candidate-token" },
        }),
      );
      expect(response.status).toBe(state === "missing" ? 410 : 503);
      if (state === "missing") {
        expect(await response.json()).toMatchObject({
          code: "selection_expired",
        });
      }
      expect(value.controls.authorise).not.toHaveBeenCalled();
      expect(value.searchService.search).not.toHaveBeenCalled();
    },
  );

  it("fails a discovery that expires between validation and atomic reservation", async () => {
    const value = runtime();
    value.controls.authorise.mockResolvedValue({
      state: "candidate_missing",
      cached: null,
      owner: "unused-owner",
      lockKey: "unused-lock",
    });
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570", candidateToken: "candidate-token" },
      }),
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "selection_expired" });
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it("fails closed when discovery validation Redis is unavailable", async () => {
    const value = runtime();
    value.controls.selectCandidate.mockRejectedValue(
      new Error("synthetic Redis failure"),
    );
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570", candidateToken: "candidate-token" },
      }),
    );
    expect(response.status).toBe(503);
    expect(value.controls.authorise).not.toHaveBeenCalled();
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it("returns authenticated health without calling SerpAPI", async () => {
    const value = runtime();
    const handler = createHealthHandler(async () => value);
    const response = await handler(request("/api/health", { token }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      fixtureMode: false,
      spentCents: 25,
    });
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it("reports paid calls as exhausted when another reservation cannot fit", async () => {
    const value = runtime();
    value.controls.status.mockResolvedValue({
      reservedCents: 990,
      providerCalls: 40,
    });
    const handler = createHealthHandler(async () => value);
    const response = await handler(request("/api/health", { token }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      liveSearchConfigured: true,
      paidCallsEnabled: false,
      spentCents: 990,
      paidPolicyState: "exhausted",
    });
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it("rejects a warm instance after its Melbourne budget month rolls over", async () => {
    const value = runtime();
    const handler = createCompetitorSearchHandler(
      async () => value,
      () => Date.parse("2026-08-31T14:00:00.000Z"),
    );
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570" },
      }),
    );
    expect(response.status).toBe(503);
    expect(value.redis.get).not.toHaveBeenCalled();
    expect(value.controls.selectCandidate).not.toHaveBeenCalled();
    expect(value.controls.authorise).not.toHaveBeenCalled();
    expect(value.searchService.search).not.toHaveBeenCalled();
  });

  it("uses an HMAC-derived Redis key rather than the bearer token", () => {
    const key = accessTokenKey(token, "p".repeat(32));
    expect(key).toMatch(/^swl:auth:token:[a-f0-9]{64}$/u);
    expect(key).not.toContain(token);
  });

  it("never places the bearer value in Redis search keys or API responses", async () => {
    const value = runtime();
    let authenticationKey = "";
    value.redis.get.mockImplementation(async (key?: string) => {
      authenticationKey = key ?? "";
      return {
        sub: "saj",
        enabled: true,
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
    });
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570" },
      }),
    );
    const responseText = await response.text();
    const authorisedCacheKey = value.controls.authorise.mock.calls[0]?.[1];
    expect(authenticationKey).not.toContain(token);
    expect(authorisedCacheKey).not.toContain(token);
    expect(responseText).not.toContain(token);
  });
});

describe("Redis search controls", () => {
  const config = {
    budgetPeriod: "2026-08",
    budgetRetentionExpiresAtSeconds: 1_790_812_800,
    providerLocation,
    perUserPerMinute: 5,
    globalPerMinute: 10,
    costCeilingCents: 1000,
    costPerCallCents: 25,
    cacheTtlSeconds: 900,
  };

  it("uses a non-JSON Lua envelope so Upstash retains discovery and cache replies as strings", async () => {
    const raw = JSON.stringify(cachedOutcome);
    const { redis: bareRedis } = upstashRedisReturning(raw, ["cache", raw]);
    expect(await bareRedis.eval("return ARGV[1]", [], [])).toEqual(
      cachedOutcome,
    );
    expect(await bareRedis.eval("return {'cache', ARGV[1]}", [], [])).toEqual([
      "cache",
      cachedOutcome,
    ]);

    const enveloped = `swl-json-v1:${raw}`;
    const { redis, commands } = upstashRedisReturning(enveloped, [
      "cache",
      enveloped,
    ]);
    const controls = createRedisControls(redis, config, () => 125_000);
    const selected = await controls.selectCandidate(
      "LW4570",
      "candidate-token",
    );
    expect(selected).toMatchObject({
      state: "selected",
      candidate: selectedCandidate,
      discoveryDigest: expect.stringMatching(/^[a-f0-9]{40}$/u),
    });
    await expect(
      controls.authorise(
        "saj",
        requestCacheKey("LW4570", "", providerLocation),
      ),
    ).resolves.toMatchObject({ state: "cache", cached: raw });
    expect(commands).toHaveLength(2);
    expect(commands[0]?.[1]).toContain("swl-json-v1:");
    expect(commands[1]?.[1]).toContain("swl-json-v1:");
  });

  it("fails closed if Upstash returns an auto-deserialised JSON object", async () => {
    const discoveryControls = createRedisControls(
      upstashRedisReturning(JSON.stringify(cachedOutcome)).redis,
      config,
    );
    await expect(
      discoveryControls.selectCandidate("LW4570", "candidate-token"),
    ).resolves.toEqual({ state: "invalid" });

    const cacheControls = createRedisControls(
      upstashRedisReturning(["cache", JSON.stringify(cachedOutcome)]).redis,
      config,
    );
    await expect(
      cacheControls.authorise(
        "saj",
        requestCacheKey("LW4570", "", providerLocation),
      ),
    ).rejects.toThrow("invalid control result");
  });

  it("passes Redis keys and arguments in the order used by the atomic script", async () => {
    const calls: Array<{
      script: string;
      keys: string[];
      args: Array<string | number>;
    }> = [];
    const redis = {
      eval: vi.fn(
        async (
          script: string,
          keys: string[],
          args: Array<string | number>,
        ) => {
          calls.push({ script, keys, args });
          return ["authorised"];
        },
      ),
    };
    const controls = createRedisControls(redis, config, () => 125_000);
    const cacheKey = requestCacheKey("LW4570", "", providerLocation);
    const result = await controls.authorise("saj", cacheKey);

    expect(result.state).toBe("authorised");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.keys).toEqual([
      "swl:rate:user:saj:2",
      "swl:rate:global:2",
      "swl:budget:2026-08",
      cacheKey,
      `swl:flight:${cacheKey.slice(cacheKey.lastIndexOf(":") + 1)}`,
      cacheKey,
    ]);
    expect(calls[0]?.args.slice(0, 7)).toEqual([
      120,
      5,
      10,
      1000,
      25,
      1_790_812_800,
      expect.stringMatching(/^[A-Za-z0-9_-]{24}$/u),
    ]);
    expect(calls[0]?.args.slice(7)).toEqual([18_000, ""]);
    expect(calls[0]?.script).toContain(
      "redis.call('EXPIREAT', KEYS[3], ARGV[6])",
    );
  });

  it("validates a complete search outcome before writing it to Redis", async () => {
    const redis = { eval: vi.fn(async () => 1) };
    const controls = createRedisControls(redis, config);
    await expect(
      controls.complete(
        requestCacheKey("Lockwood 001", "", providerLocation),
        "swl:flight:valid",
        "owner",
        cachedOfferOutcome,
      ),
    ).resolves.toBeUndefined();
    expect(redis.eval).toHaveBeenCalledOnce();

    const corrupt = structuredClone(cachedOfferOutcome);
    corrupt.results[0]!.totalPriceCents = 10_500;
    corrupt.results[0]!.totalPriceAud = "105.00";
    await expect(
      controls.complete(
        requestCacheKey("Lockwood 001", "", providerLocation),
        "swl:flight:invalid",
        "owner",
        corrupt,
      ),
    ).rejects.toThrow("search outcome");
    expect(redis.eval).toHaveBeenCalledOnce();
  });

  it("versions Redis cache keys for the semantic validation contract", () => {
    expect(requestCacheKey("LW4570", "", providerLocation)).toMatch(
      /^swl:cache:immersive-v3:[a-f0-9]{64}$/u,
    );
  });

  it("separates discovery and offer cache identities by provider location", () => {
    expect(requestCacheKey("LW4570", "", providerLocation)).not.toBe(
      requestCacheKey("LW4570", "", otherProviderLocation),
    );
    expect(
      requestCacheKey("LW4570", "candidate-token", providerLocation),
    ).not.toBe(
      requestCacheKey("LW4570", "candidate-token", otherProviderLocation),
    );
  });

  it("cannot reuse a discovery selection after the provider location changes", async () => {
    const raw = `swl-json-v1:${JSON.stringify(cachedOutcome)}`;
    const geelongDiscoveryKey = requestCacheKey("LW4570", "", providerLocation);
    const redis = {
      eval: vi.fn(async (_script: string, keys: string[]) =>
        keys[0] === geelongDiscoveryKey ? raw : null,
      ),
    };
    const geelongControls = createRedisControls(redis, {
      ...config,
      providerLocation,
    });
    const melbourneControls = createRedisControls(redis, {
      ...config,
      providerLocation: otherProviderLocation,
    });
    const selected = await geelongControls.selectCandidate(
      "LW4570",
      "candidate-token",
    );
    expect(selected).toMatchObject({
      state: "selected",
      providerLocation,
    });
    await expect(
      melbourneControls.selectCandidate("LW4570", "candidate-token"),
    ).resolves.toEqual({ state: "missing" });
    await expect(
      melbourneControls.authorise(
        "saj",
        requestCacheKey("LW4570", "candidate-token", otherProviderLocation),
        {
          discoveryKey: selected.discoveryKey,
          discoveryDigest: selected.discoveryDigest,
          providerLocation: selected.providerLocation,
        },
      ),
    ).rejects.toThrow("provider location");
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it("checks the discovery proof before user, global or budget mutation", async () => {
    const discoveryRaw = JSON.stringify(cachedOutcome);
    const calls: Array<{
      script: string;
      keys: string[];
      args: Array<string | number>;
    }> = [];
    const redis = {
      eval: vi.fn(
        async (
          script: string,
          keys: string[],
          args: Array<string | number>,
        ) => {
          calls.push({ script, keys, args });
          return calls.length === 1
            ? `swl-json-v1:${discoveryRaw}`
            : ["authorised"];
        },
      ),
    };
    const controls = createRedisControls(redis, config, () => 125_000);
    const selected = await controls.selectCandidate(
      "LW4570",
      "candidate-token",
    );
    expect(selected).toMatchObject({
      state: "selected",
      candidate: selectedCandidate,
      discoveryKey: requestCacheKey("LW4570", "", providerLocation),
      discoveryDigest: expect.stringMatching(/^[a-f0-9]{40}$/u),
      providerLocation,
    });

    await controls.authorise(
      "saj",
      requestCacheKey("LW4570", "candidate-token", providerLocation),
      {
        discoveryKey: selected.discoveryKey,
        discoveryDigest: selected.discoveryDigest,
        providerLocation: selected.providerLocation,
      },
    );
    const authorise = calls[1]!;
    expect(authorise.keys[5]).toBe(
      requestCacheKey("LW4570", "", providerLocation),
    );
    expect(authorise.args[8]).toBe(selected.discoveryDigest);
    const discoveryCheck = authorise.script.indexOf(
      "redis.call('GET', KEYS[6])",
    );
    const userIncrement = authorise.script.indexOf(
      "redis.call('INCR', KEYS[1])",
    );
    const budgetRead = authorise.script.indexOf(
      "redis.call('HGET', KEYS[3], 'reservedCents'",
    );
    const globalIncrement = authorise.script.indexOf(
      "redis.call('INCR', KEYS[2])",
    );
    const budgetIncrement = authorise.script.indexOf(
      "redis.call('HINCRBY', KEYS[3], 'reservedCents'",
    );
    expect(discoveryCheck).toBeGreaterThanOrEqual(0);
    expect(discoveryCheck).toBeLessThan(userIncrement);
    expect(userIncrement).toBeLessThan(budgetRead);
    expect(budgetRead).toBeLessThan(globalIncrement);
    expect(globalIncrement).toBeLessThan(budgetIncrement);
  });

  it("selects a discovery candidate across equivalent query casing", async () => {
    const redis = {
      eval: vi.fn(async () => `swl-json-v1:${JSON.stringify(cachedOutcome)}`),
    };
    const controls = createRedisControls(redis, config);
    await expect(
      controls.selectCandidate("lw4570", "candidate-token"),
    ).resolves.toMatchObject({
      state: "selected",
      candidate: selectedCandidate,
      discoveryKey: requestCacheKey("LW4570", "", providerLocation),
      providerLocation,
    });
  });

  it.each([
    { name: "missing", raw: null, state: "missing" },
    { name: "malformed JSON", raw: "swl-json-v1:{", state: "invalid" },
    {
      name: "wrong query",
      raw: `swl-json-v1:${JSON.stringify({
        ...cachedOutcome,
        query: "OTHER",
      })}`,
      state: "invalid",
    },
    {
      name: "oversized candidate URL",
      raw: `swl-json-v1:${JSON.stringify({
        ...cachedOutcome,
        candidates: [
          {
            ...selectedCandidate,
            productUrl: `https://www.google.com/${"x".repeat(2_100)}`,
          },
        ],
      })}`,
      state: "invalid",
    },
    {
      name: "unissued token",
      raw: `swl-json-v1:${JSON.stringify(cachedOutcome)}`,
      state: "missing",
      token: "not-issued",
    },
  ])(
    "fails $name discovery without running authorisation",
    async ({ raw, state, token: candidate = "candidate-token" }) => {
      const redis = { eval: vi.fn(async () => raw) };
      const controls = createRedisControls(redis, config);
      expect(await controls.selectCandidate("LW4570", candidate)).toEqual({
        state,
      });
      expect(redis.eval).toHaveBeenCalledOnce();
    },
  );
});

describe("Vercel configuration", () => {
  const validEnv = {
    SERPAPI_KEY: "a".repeat(64),
    SERPAPI_LOCATION: "Geelong, Victoria, Australia",
    SWL_ACCESS_TOKEN_PEPPER: "p".repeat(32),
    SWL_REDIS_REST_URL: "https://redis.example.test",
    SWL_REDIS_REST_TOKEN: "r".repeat(16),
    SWL_FRONTEND_ORIGIN: origin,
    SWL_PAID_CALLS_ENABLED: "true",
    SWL_PROVIDER_COST_CEILING_CENTS: "1000",
    SWL_PROVIDER_COST_PER_CALL_CENTS: "25",
    SWL_PROVIDER_BUDGET_PERIOD: "2026-08",
    SWL_SEARCH_PER_USER_PER_MINUTE: "5",
    SWL_SEARCH_GLOBAL_PER_MINUTE: "10",
    SWL_SEARCH_CACHE_TTL_SECONDS: "900",
  };

  it("accepts only the current Melbourne budget month with deterministic retention", () => {
    expect(readVercelConfig(validEnv, vercelTestClock)).toMatchObject({
      costCeilingCents: 1000,
      costPerCallCents: 25,
      budgetPeriod: "2026-08",
      budgetRetentionExpiresAtSeconds: 1_790_812_800,
      providerLocation,
    });
  });

  it("returns the canonical validated provider location", () => {
    expect(
      readVercelConfig(
        {
          ...validEnv,
          SERPAPI_LOCATION: " Geelong , Victoria , Australia ",
        },
        vercelTestClock,
      ).providerLocation,
    ).toBe(providerLocation);
  });

  it.each([32, 64])("accepts an opaque %i-character SerpAPI key", (length) => {
    expect(() =>
      readVercelConfig(
        { ...validEnv, SERPAPI_KEY: "a".repeat(length) },
        vercelTestClock,
      ),
    ).not.toThrow();
  });

  it("uses the Melbourne month at the UTC rollover boundary", () => {
    expect(() =>
      readVercelConfig(validEnv, () => Date.parse("2026-08-31T13:59:59.000Z")),
    ).not.toThrow();
    expect(() =>
      readVercelConfig(validEnv, () => Date.parse("2026-08-31T14:00:00.000Z")),
    ).toThrow("current Australia/Melbourne month");
  });

  it.each([
    { name: "missing SerpAPI key", values: { SERPAPI_KEY: undefined } },
    { name: "malformed SerpAPI key", values: { SERPAPI_KEY: "placeholder" } },
    {
      name: "oversized SerpAPI key",
      values: { SERPAPI_KEY: "a".repeat(257) },
    },
    {
      name: "SerpAPI key with controls",
      values: { SERPAPI_KEY: `${"a".repeat(31)}\n` },
    },
    { name: "missing location", values: { SERPAPI_LOCATION: undefined } },
    {
      name: "non-Australian location",
      values: { SERPAPI_LOCATION: "London, England, United Kingdom" },
    },
  ])("fails startup for $name", ({ values }) => {
    expect(() =>
      readVercelConfig({ ...validEnv, ...values }, vercelTestClock),
    ).toThrow();
  });
});

describe("web access token provisioning", () => {
  it("requires Redis SET NX success before writing or announcing a token", () => {
    const source = readFileSync(
      new URL("../scripts/provision-web-access-token.mjs", import.meta.url),
      "utf8",
    );
    const assignment = source.indexOf("const created = await redis.set(");
    const successCheck = source.indexOf('if (created !== "OK")');
    const fileWrite = source.indexOf("await writeFile(");
    const announcement = source.indexOf("console.log(");
    expect(assignment).toBeGreaterThanOrEqual(0);
    expect(successCheck).toBeGreaterThan(assignment);
    expect(successCheck).toBeLessThan(fileWrite);
    expect(successCheck).toBeLessThan(announcement);
  });
});

describe("Vercel runtime search service", () => {
  it("leaves cache and rate authority to Redis after reservation", async () => {
    const runtimeModule = await import("../server/vercel/runtime.mjs");
    expect(runtimeModule).toHaveProperty("createVercelSearchService");
    const createVercelSearchService = (
      runtimeModule as unknown as {
        createVercelSearchService: (
          provider: Record<string, unknown>,
          config: Record<string, unknown>,
        ) => {
          search(query: string): Promise<unknown>;
        };
      }
    ).createVercelSearchService;
    let calls = 0;
    const service = createVercelSearchService(
      {
        name: "synthetic-provider",
        configured: true,
        requiresPaidCall: true,
        async search() {
          calls += 1;
          return [];
        },
      },
      { costCeilingCents: 1000, costPerCallCents: 25 },
    );
    await service.search("same query");
    await service.search("same query");
    for (let index = 0; index < 11; index += 1) {
      await service.search(`distinct query ${index}`);
    }
    expect(calls).toBe(13);
  });
});

describe("cross-instance selected candidate metadata", () => {
  function immersiveFixture() {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/serpapi-immersive-offers.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    (fixture.search_parameters as Record<string, unknown>).page_token =
      selectedCandidate.token;
    return fixture;
  }

  it("uses the Redis-validated candidate on a fresh provider instance", async () => {
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: "synthetic-placeholder" },
      async () =>
        new Response(JSON.stringify(immersiveFixture()), {
          headers: { "content-type": "application/json" },
        }),
    );
    const payload = await provider.search("ignored at offer stage", {
      candidateToken: selectedCandidate.token,
      selectedCandidate,
    });
    expect(payload).toMatchObject({
      stage: "offers",
      selectedProduct: {
        title: "Lockwood 001 Double Cylinder Deadlatch",
        brand: "Lockwood",
        productId: "4570",
      },
    });
    expect(
      payload.offers.every(
        (offer: { condition: string }) => offer.condition === "used",
      ),
    ).toBe(true);
  });

  it("preserves candidate identity through handler, service and a fresh provider", async () => {
    const runtimeModule = await import("../server/vercel/runtime.mjs");
    const createSearch = (
      runtimeModule as unknown as {
        createVercelSearchService: (
          provider: Record<string, unknown>,
          config: Record<string, unknown>,
        ) => {
          search(
            query: string,
            candidateToken?: string,
            candidate?: unknown,
          ): Promise<unknown>;
        };
      }
    ).createVercelSearchService;
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: "synthetic-placeholder" },
      async () =>
        new Response(JSON.stringify(immersiveFixture()), {
          headers: { "content-type": "application/json" },
        }),
    );
    const base = runtime();
    const value = runtime({
      provider,
      searchService: createSearch(provider, base.config),
    });
    const handler = createCompetitorSearchHandler(async () => value);
    const response = await handler(
      request("/api/competitor-search", {
        method: "POST",
        token,
        body: { query: "LW4570", candidateToken: "candidate-token" },
      }),
    );
    expect(response.status).toBe(200);
    const outcome = (await response.json()) as {
      state: string;
      selectedProduct: { brand: string | null; productId: string | null };
      results: Array<{
        condition: string;
        comparisonEligible: boolean;
        exclusionReasons: string[];
      }>;
    };
    expect(outcome).toMatchObject({
      state: "no_comparable_offers",
      selectedProduct: {
        brand: "Lockwood",
        productId: "4570",
      },
    });
    expect(outcome.results).toHaveLength(5);
    expect(
      outcome.results.every(
        (offer) =>
          offer.condition === "used" &&
          offer.comparisonEligible === false &&
          offer.exclusionReasons.includes("used_or_second_hand"),
      ),
    ).toBe(true);
  });

  it("excludes missing or different pack sizes while retaining the offers", async () => {
    const body = immersiveFixture();
    const product = body.product_results as Record<string, unknown>;
    const stores = product.stores as Array<Record<string, unknown>>;
    stores[0]!.title = "Lockwood 001 Double Cylinder Deadlatch 2 Pack";
    stores[1]!.title = "Lockwood 001 Double Cylinder Deadlatch 2 Pack";
    stores[2]!.title = "Lockwood 001 Double Cylinder Deadlatch 3 Pack";
    const provider = createSerpApiProvider(
      { SERPAPI_KEY: "synthetic-placeholder" },
      async () =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        }),
    );
    const payload = await provider.search("ignored at offer stage", {
      candidateToken: selectedCandidate.token,
      selectedCandidate: {
        ...selectedCandidate,
        condition: "new",
        packSize: "pack of 2",
      },
    });
    const offers = payload.offers as Array<{
      seller: string;
      comparisonEligible: boolean;
      exclusionReasons: string[];
    }>;
    expect(offers).toHaveLength(5);
    expect(offers[0]).toMatchObject({
      seller: "Merchant One",
      comparisonEligible: true,
      exclusionReasons: [],
    });
    expect(offers[1]).toMatchObject({
      seller: "Merchant Two",
      comparisonEligible: false,
      exclusionReasons: ["pack_mismatch"],
    });
    expect(offers[2]?.exclusionReasons).toContain("pack_mismatch");
  });
});
