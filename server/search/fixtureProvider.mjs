/**
 * Deterministic fixture provider. Implements the same interface as the real
 * providers so the whole test suite runs offline with no key and no network.
 *
 * Interface (shared with the structured providers):
 *   provider.name                  -> string
 *   provider.configured            -> boolean
 *   provider.singleStageOffers     -> true (offers are returned without a
 *                                     candidate-selection round trip)
 *   provider.search(providerQuery, { signal }) -> Promise<ProviderPayload>
 *
 * ProviderPayload (structured offers stage):
 *   { stage: 'offers', selectedProduct, offers, providerMeta }
 * where every offer carries the full delivered-price evidence contract
 * (itemPriceCents, shippingCents, totalPriceCents, comparisonPriceCents,
 * priceBasis, currencyBasis, condition, availability, financing,
 * comparisonEligible, exclusionReasons) accepted by the search service.
 *
 * Magic queries drive failure states deterministically:
 *   containing "fixture-timeout" -> AbortError-equivalent timeout
 *   containing "fixture-error"   -> provider HTTP 500 error
 *   containing "fixture-quota"   -> quota exhausted error
 *   containing "fixture-none"    -> empty discovery (no candidates)
 *   containing "fixture-slow"    -> resolves after `slowMs` (default 1500 ms)
 */

import { displayProviderQuery } from "./freeProviderUtils.mjs";
import {
  ProviderQuotaError,
  ProviderRequestError,
  ProviderTimeoutError,
} from "./providerErrors.mjs";
export {
  ProviderQuotaError,
  ProviderRequestError,
  ProviderSelectionExpiredError,
  ProviderTimeoutError,
} from "./providerErrors.mjs";

const FIXTURE_CATALOGUE = [
  // Deterministic multi-source results for locksmith-flavoured queries.
  {
    match: /lw4570|deadlatch|4570/,
    results: [
      r(
        "Lockwood 4570 Keyed Deadlatch Satin Chrome",
        14350,
        "inc-gst",
        "each",
        "Fictionville Security Supplies",
        "fictionville-security.example.com.au",
      ),
      r(
        "Lockwood 4570SC Deadlatch - Trade Pack",
        13900,
        "inc-gst",
        "each",
        "Fictionville Hardware Direct",
        "fictionville-hardware.example.com.au",
      ),
      r(
        "LW4570 Deadlatch Chrome Body Only",
        12995,
        "unknown",
        null,
        "Example Trade Locks AU",
        "example-tradelocks.example.com.au",
      ),
      r(
        "Lockwood 4570 Deadlatch (Box of 2)",
        26500,
        "inc-gst",
        "box of 2",
        "Fictionville Wholesale",
        "fictionville-wholesale.example.com.au",
      ),
    ],
  },
  {
    match: /padlock|abus|9053/,
    results: [
      r(
        "ABUS 9053 Granit Padlock 53 mm",
        9900,
        "inc-gst",
        "each",
        "Fictionville Security Supplies",
        "fictionville-security.example.com.au",
      ),
      r(
        "ABUS Granit 9053 High Security Padlock",
        10450,
        "inc-gst",
        "each",
        "Example Trade Locks AU",
        "example-tradelocks.example.com.au",
      ),
      r(
        "ABUS 9053 Padlock Twin Pack",
        18900,
        "unknown",
        "pack of 2",
        "Fictionville Wholesale",
        "fictionville-wholesale.example.com.au",
      ),
    ],
  },
  {
    match: /cylinder|c4|kaba/,
    results: [
      r(
        "Kaba C4 6-Pin Cylinder Nickel",
        6875,
        "inc-gst",
        "each",
        "Fictionville Hardware Direct",
        "fictionville-hardware.example.com.au",
      ),
      r(
        "C4 Euro Cylinder 60 mm",
        7200,
        "ex-gst",
        "each",
        "Fictionville Wholesale",
        "fictionville-wholesale.example.com.au",
      ),
    ],
  },
];

/**
 * Every fixture offer ships free with an explicit AUD price so it satisfies
 * the delivered-total comparison contract deterministically.
 */
function r(title, priceCents, gstBasis, packSize, seller, sourceDomain) {
  return {
    title,
    itemPriceCents: priceCents,
    shippingCents: 0,
    estimatedTaxCents: null,
    totalPriceCents: priceCents,
    comparisonPriceCents: priceCents,
    priceBasis: "item_plus_shipping",
    originalPriceText: `A$${(priceCents / 100).toFixed(2)}`,
    currencyBasis: "explicit-aud",
    gstBasis,
    packSize,
    condition: "new",
    availability: "in-stock",
    financing: false,
    comparisonEligible: true,
    exclusionReasons: [],
    seller,
    sourceDomain,
    url: `https://${sourceDomain}/product/${encodeURIComponent(title.toLowerCase().replace(/\s+/g, "-"))}`,
  };
}

function fixtureProviderMeta() {
  return {
    observedAt: null,
    cacheBasis: "provider_cache_bypassed",
    storesMayContinue: false,
  };
}

export function createFixtureProvider(options = {}) {
  const slowMs = options.slowMs ?? 1500;
  return {
    name: "fixture",
    requiresPaidCall: false,
    singleStageOffers: true,
    configured: true,
    capabilities: {
      id: "fixture",
      displayName: "Deterministic fixture",
      mode: "single-stage-structured-offers",
      authentication: "none",
      configured: true,
      quota: { kind: "unmetered-local" },
      limits: { concurrency: 3, requestsPerMinute: 600 },
      cache: { ttlSeconds: 900, persistent: false },
      health: "healthy",
      lastSuccess: null,
      lastErrorCategory: null,
      dataRights: "Synthetic offline evidence only.",
      supportedIdentityFields: ["gtin", "mpn", "brand", "model", "title"],
    },
    async search(providerQuery, { signal } = {}) {
      const q = providerQuery.toLowerCase();
      if (q.includes("fixture-timeout")) throw new ProviderTimeoutError();
      if (q.includes("fixture-quota")) throw new ProviderQuotaError();
      if (q.includes("fixture-error"))
        throw new ProviderRequestError("HTTP 500");
      if (q.includes("fixture-slow")) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, slowMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new ProviderTimeoutError());
          });
        });
      }
      if (q.includes("fixture-none")) {
        return {
          stage: "discovery",
          candidates: [],
          providerMeta: fixtureProviderMeta(),
        };
      }
      const selectedTitle =
        displayProviderQuery(providerQuery) ?? "Fixture product";
      const entry = FIXTURE_CATALOGUE.find((e) => e.match.test(q));
      // Unknown queries return one generic priced result so free-text
      // searches behave deterministically instead of appearing broken.
      const offers = entry
        ? entry.results.map((item) => ({
            ...item,
            exclusionReasons: [...item.exclusionReasons],
          }))
        : [
            r(
              `Fixture result for ${selectedTitle}`,
              4995,
              "inc-gst",
              "each",
              "Fictionville Security Supplies",
              "fictionville-security.example.com.au",
            ),
          ];
      return {
        stage: "offers",
        selectedProduct: {
          title: selectedTitle,
          brand: null,
          productId: null,
        },
        offers,
        providerMeta: fixtureProviderMeta(),
      };
    },
  };
}
