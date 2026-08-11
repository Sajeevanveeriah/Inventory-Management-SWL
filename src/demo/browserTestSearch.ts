import {
  centsToAud,
  type LiveSearchOutcome,
  type LiveSearchResult,
} from "../core/liveSearch";

export type BrowserTestSearchScenario =
  | "results"
  | "empty"
  | "timeout"
  | "provider_error";

function stableOffset(query: string): number {
  let hash = 0;
  for (const character of query.toLowerCase()) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % 1200;
}

function result(
  query: string,
  seller: string,
  sourceDomain: string,
  priceCents: number,
  retrievedAt: string,
  index: number,
): LiveSearchResult {
  return {
    title: `${query} - fictional test listing ${index + 1}`,
    priceCents,
    priceAud: centsToAud(priceCents),
    currency: "AUD",
    gstBasis: index === 2 ? "unknown" : "inc-gst",
    packSize: index === 1 ? "1 each, test delivery included" : "1 each",
    seller,
    sourceDomain,
    url: `https://${sourceDomain}/swl-browser-test/${index + 1}`,
    retrievedAt,
  };
}

export function createBrowserTestSearchOutcome(
  rawQuery: string,
  scenario: BrowserTestSearchScenario,
  retrievedAt = new Date().toISOString(),
): LiveSearchOutcome {
  const query = rawQuery.trim();
  const base = {
    query,
    queryKind: "free-text" as const,
    provider: "browser-test-fixture",
  };

  if (scenario !== "results") {
    return {
      ...base,
      state: scenario,
      results: [],
      band: null,
      retrievedAt,
      cached: false,
      detail:
        scenario === "empty"
          ? "The fictional provider returned no test listings."
          : scenario === "timeout"
            ? "The fictional provider exceeded the test time limit."
            : "The fictional provider returned a deliberate test error.",
      coverage: {
        providerQueried: "browser-test-fixture",
        sourcesWithPrice: 0,
        sourceDomains: [],
        pricedResults: 0,
      },
    };
  }

  const offset = stableOffset(query);
  const prices: [number, number, number] = [
    12_950 + offset,
    14_250 + offset,
    15_600 + offset,
  ];
  const results = [
    result(query, "Fictional Geelong Locks", "example.com", prices[0], retrievedAt, 0),
    result(query, "Sample Trade Hardware", "example.net", prices[1], retrievedAt, 1),
    result(query, "Demo Security Supplies", "example.org", prices[2], retrievedAt, 2),
  ];

  return {
    ...base,
    state: "ok",
    results,
    band: {
      lowest: centsToAud(prices[0]),
      median: centsToAud(prices[1]),
      highest: centsToAud(prices[2]),
      lowestCents: prices[0],
      medianCents: prices[1],
      highestCents: prices[2],
      pricedResults: results.length,
    },
    retrievedAt,
    cached: false,
    detail:
      "Deterministic fictional browser test. No provider request or charge occurred.",
    coverage: {
      providerQueried: "browser-test-fixture",
      sourcesWithPrice: results.length,
      sourceDomains: results.map((item) => item.sourceDomain),
      pricedResults: results.length,
    },
  };
}
