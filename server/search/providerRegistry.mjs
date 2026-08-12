import { createEbayBrowseProvider } from "./ebayBrowseProvider.mjs";
import { createSerpApiProvider } from "./serpapiProvider.mjs";
import { createSerperShoppingProvider } from "./serperShoppingProvider.mjs";

/** Capability contract shared by every retrieval adapter. Credentials stay server-side. */
export function providerCapabilities(provider, overrides = {}) {
  return Object.freeze({
    id: provider.name,
    displayName: provider.name,
    mode: "structured-offers",
    authentication: "none",
    configured: Boolean(provider.configured),
    quota: { kind: "unknown" },
    limits: { concurrency: 1, requestsPerMinute: 10 },
    cache: { ttlSeconds: 900, persistent: false },
    health: "unknown",
    lastSuccess: null,
    lastErrorCategory: null,
    dataRights: "Operator must confirm provider terms and authority.",
    supportedIdentityFields: ["gtin", "mpn", "brand", "model", "title"],
    ...overrides,
  });
}

export function createDisabledProvider({
  id,
  displayName,
  authentication,
  dataRights,
  mode = "structured-offers",
}) {
  return {
    name: id,
    configured: false,
    capabilities: providerCapabilities(
      { name: id, configured: false },
      {
        displayName,
        authentication,
        mode,
        health: "not-configured",
        dataRights,
      },
    ),
    async search() {
      const error = new Error(`${displayName} is not configured`);
      error.name = "ProviderNotConfiguredError";
      throw error;
    },
  };
}

export function optionalProviderRegistry(env = process.env) {
  return [
    createSerpApiProvider(env),
    createSerperShoppingProvider(env),
    createEbayBrowseProvider(env),
    createDisabledProvider({
      id: "merchant-market-benchmark",
      displayName: "Google Merchant market benchmark",
      authentication: "OAuth and eligible Merchant account",
      mode: "aggregate-benchmark",
      dataRights:
        "Aggregate benchmark only; keep separate from individual offers.",
    }),
    createDisabledProvider({
      id: "generic-http-json-feed",
      displayName: "Authorised HTTP JSON feed",
      authentication: env.SWL_HTTP_FEED_BEARER_TOKEN
        ? "Bearer token configured"
        : "Bearer token optional",
      dataRights:
        "Only operator-authorised, allowlisted HTTPS supplier endpoints.",
    }),
    createDisabledProvider({
      id: "searxng-discovery",
      displayName: "SearXNG discovery",
      authentication: "deployment-specific",
      mode: "web-discovery",
      dataRights:
        "Discovery only; obey site terms, robots controls and rate limits. No bypasses.",
    }),
  ];
}

/** Select one live provider without ever moving a credential into the browser. */
export function createProviderFromEnvironment(
  env = process.env,
  fetchImpl = fetch,
) {
  const requested = (env.SWL_SEARCH_PROVIDER ?? "").trim().toLowerCase();
  if (["serper", "serper-shopping-au"].includes(requested)) {
    return createSerperShoppingProvider(env, fetchImpl);
  }
  if (["ebay", "ebay-browse-au"].includes(requested)) {
    return createEbayBrowseProvider(env, fetchImpl);
  }
  if (["serpapi", "serpapi-google-shopping-au"].includes(requested)) {
    return createSerpApiProvider(env, fetchImpl);
  }
  if (requested !== "") {
    throw new Error("SWL_SEARCH_PROVIDER must be serpapi, serper or ebay.");
  }
  if (createSerperShoppingProvider(env, fetchImpl).configured) {
    return createSerperShoppingProvider(env, fetchImpl);
  }
  if (createEbayBrowseProvider(env, fetchImpl).configured) {
    return createEbayBrowseProvider(env, fetchImpl);
  }
  return createSerpApiProvider(env, fetchImpl);
}

export function publicProviderStatus(provider) {
  const c = provider.capabilities ?? providerCapabilities(provider);
  return {
    id: c.id,
    displayName: c.displayName,
    mode: c.mode,
    authentication: c.authentication,
    configured: c.configured,
    quota: c.quota,
    limits: c.limits,
    cache: c.cache,
    health: c.health,
    lastSuccess: c.lastSuccess,
    lastErrorCategory: c.lastErrorCategory,
    dataRights: c.dataRights,
    supportedIdentityFields: c.supportedIdentityFields,
  };
}
