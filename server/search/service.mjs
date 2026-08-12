import { centsToAmount } from "../lib/moneyCents.mjs";
import { buildProviderQuery } from "./normaliseQuery.mjs";
import {
  ProviderQuotaError,
  ProviderRequestError,
  ProviderSelectionExpiredError,
  ProviderTimeoutError,
} from "./providerErrors.mjs";

/**
 * Live search orchestration: rate limit, local cache, paid-call reservation,
 * provider boundary validation, and explicit outcome states.
 */

const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_QUERY_CHARACTERS = 512;
const MAX_PROVIDER_RESULTS = 100;
const MAX_CENTS = 1_000_000_000;
const MAX_TOKEN_CHARACTERS = 8_192;

function isBoundedProviderText(value, max, allowEmpty = false) {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.length > 0) &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}

function validCents(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS;
}

function validNullableCents(value) {
  return value === null || validCents(value);
}

function exactKeys(value, expected, detail) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRequestError(detail);
  }
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new ProviderRequestError(`${detail} contains unsupported fields`);
  }
}

function validatedHttpsUrl(value, sourceDomain) {
  if (!isBoundedProviderText(value, 2_048)) {
    throw new ProviderRequestError("provider result URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProviderRequestError("provider result URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    (sourceDomain !== undefined &&
      parsed.hostname.toLowerCase() !== sourceDomain.toLowerCase())
  ) {
    throw new ProviderRequestError(
      "provider result URL is outside the approved boundary",
    );
  }
  return parsed;
}

function validateProviderResults(value) {
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_RESULTS) {
    throw new ProviderRequestError(
      "provider result count is outside the supported range",
    );
  }
  const expectedKeys = [
    "gstBasis",
    "packSize",
    "priceCents",
    "seller",
    "sourceDomain",
    "title",
    "url",
  ];
  return value.map((item) => {
    exactKeys(item, expectedKeys, "provider result");
    if (
      !isBoundedProviderText(item.title, 1_000) ||
      !validCents(item.priceCents) ||
      !["inc-gst", "ex-gst", "unknown"].includes(item.gstBasis) ||
      (item.packSize !== null &&
        !isBoundedProviderText(item.packSize, 256, true)) ||
      !isBoundedProviderText(item.seller, 512) ||
      !isBoundedProviderText(item.sourceDomain, 253)
    ) {
      throw new ProviderRequestError(
        "provider result is outside the supported range",
      );
    }
    const sourceUrl = validatedHttpsUrl(item.url, item.sourceDomain);
    return {
      title: item.title,
      priceCents: item.priceCents,
      gstBasis: item.gstBasis,
      packSize: item.packSize,
      seller: item.seller,
      sourceDomain: sourceUrl.hostname.toLowerCase(),
      url: sourceUrl.href,
    };
  });
}

function validateProviderMeta(value) {
  exactKeys(
    value,
    ["cacheBasis", "observedAt", "storesMayContinue"],
    "provider metadata",
  );
  if (
    !["provider_cache_allowed", "provider_cache_bypassed"].includes(
      value.cacheBasis,
    ) ||
    typeof value.storesMayContinue !== "boolean" ||
    (value.observedAt !== null &&
      (!isBoundedProviderText(value.observedAt, 64) ||
        Number.isNaN(Date.parse(value.observedAt)) ||
        new Date(value.observedAt).toISOString() !== value.observedAt))
  ) {
    throw new ProviderRequestError("provider metadata is invalid");
  }
  return {
    observedAt: value.observedAt,
    cacheBasis: value.cacheBasis,
    storesMayContinue: value.storesMayContinue,
  };
}

function validateCandidate(value) {
  exactKeys(
    value,
    [
      "brand",
      "condition",
      "displayedPrice",
      "multipleSources",
      "packSize",
      "position",
      "priceCents",
      "productId",
      "productUrl",
      "title",
      "token",
    ],
    "provider candidate",
  );
  if (
    !isBoundedProviderText(value.token, MAX_TOKEN_CHARACTERS) ||
    !isBoundedProviderText(value.title, 1_000) ||
    (value.brand !== null && !isBoundedProviderText(value.brand, 256)) ||
    (value.productId !== null &&
      !isBoundedProviderText(value.productId, 256)) ||
    (value.displayedPrice !== null &&
      !isBoundedProviderText(value.displayedPrice, 64)) ||
    !validNullableCents(value.priceCents) ||
    typeof value.multipleSources !== "boolean" ||
    (value.packSize !== null &&
      !isBoundedProviderText(value.packSize, 256, true)) ||
    !["new", "used", "unknown"].includes(value.condition) ||
    !Number.isSafeInteger(value.position) ||
    value.position < 0 ||
    value.position > 10_000
  ) {
    throw new ProviderRequestError("provider candidate is invalid");
  }
  const productUrl = validatedHttpsUrl(value.productUrl);
  const host = productUrl.hostname.toLowerCase();
  if (!(
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "google.com.au" ||
    host.endsWith(".google.com.au")
  )) {
    throw new ProviderRequestError("provider candidate URL is invalid");
  }
  return { ...value, productUrl: productUrl.href };
}

function validateSelectedProduct(value) {
  exactKeys(value, ["brand", "productId", "title"], "selected product");
  if (
    !isBoundedProviderText(value.title, 1_000) ||
    (value.brand !== null && !isBoundedProviderText(value.brand, 256)) ||
    (value.productId !== null && !isBoundedProviderText(value.productId, 256))
  ) {
    throw new ProviderRequestError("selected product is invalid");
  }
  return { title: value.title, brand: value.brand, productId: value.productId };
}

function validateOffer(value) {
  exactKeys(
    value,
    [
      "availability",
      "comparisonEligible",
      "comparisonPriceCents",
      "condition",
      "currencyBasis",
      "estimatedTaxCents",
      "exclusionReasons",
      "financing",
      "gstBasis",
      "itemPriceCents",
      "originalPriceText",
      "packSize",
      "priceBasis",
      "seller",
      "shippingCents",
      "sourceDomain",
      "title",
      "totalPriceCents",
      "url",
    ],
    "provider offer",
  );
  if (
    !isBoundedProviderText(value.title, 1_000) ||
    !validCents(value.itemPriceCents) ||
    !validNullableCents(value.shippingCents) ||
    !validNullableCents(value.estimatedTaxCents) ||
    !validNullableCents(value.totalPriceCents) ||
    !validNullableCents(value.comparisonPriceCents) ||
    !["provider_total", "item_plus_shipping", "not_comparable"].includes(
      value.priceBasis,
    ) ||
    !isBoundedProviderText(value.originalPriceText, 64) ||
    !["explicit-aud", "inferred-au-localisation"].includes(
      value.currencyBasis,
    ) ||
    !["inc-gst", "ex-gst", "unknown"].includes(value.gstBasis) ||
    (value.packSize !== null &&
      !isBoundedProviderText(value.packSize, 256, true)) ||
    !["new", "used", "unknown"].includes(value.condition) ||
    !["in-stock", "out-of-stock", "unknown"].includes(value.availability) ||
    typeof value.financing !== "boolean" ||
    typeof value.comparisonEligible !== "boolean" ||
    !Array.isArray(value.exclusionReasons) ||
    value.exclusionReasons.length > 20 ||
    value.exclusionReasons.some(
      (reason) => !isBoundedProviderText(reason, 128),
    ) ||
    !isBoundedProviderText(value.seller, 512) ||
    !isBoundedProviderText(value.sourceDomain, 253)
  ) {
    throw new ProviderRequestError("provider offer is invalid");
  }

  const sourceUrl = validatedHttpsUrl(value.url, value.sourceDomain);
  const host = sourceUrl.hostname.toLowerCase();
  if (
    host === "serpapi.com" ||
    host.endsWith(".serpapi.com") ||
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "google.com.au" ||
    host.endsWith(".google.com.au")
  ) {
    throw new ProviderRequestError("provider offer is not a merchant URL");
  }

  if (value.comparisonEligible) {
    if (
      value.exclusionReasons.length !== 0 ||
      !validCents(value.comparisonPriceCents) ||
      value.priceBasis === "not_comparable" ||
      (value.priceBasis === "provider_total" &&
        value.comparisonPriceCents !== value.totalPriceCents) ||
      (value.priceBasis === "item_plus_shipping" &&
        (!validCents(value.shippingCents) ||
          value.comparisonPriceCents !==
            value.itemPriceCents + value.shippingCents))
    ) {
      throw new ProviderRequestError("provider offer comparison is invalid");
    }
  } else if (
    value.exclusionReasons.length === 0 ||
    value.comparisonPriceCents !== null ||
    value.priceBasis !== "not_comparable"
  ) {
    throw new ProviderRequestError("provider offer exclusion is invalid");
  }

  if (
    (value.financing &&
      value.totalPriceCents === null &&
      value.comparisonEligible) ||
    (value.condition === "used" && value.comparisonEligible)
  ) {
    throw new ProviderRequestError("provider offer eligibility is invalid");
  }
  return { ...value, sourceDomain: host, url: sourceUrl.href };
}

function validateStructuredProviderPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.stage === "discovery") {
    exactKeys(
      value,
      ["candidates", "providerMeta", "stage"],
      "provider discovery payload",
    );
    if (
      !Array.isArray(value.candidates) ||
      value.candidates.length > MAX_PROVIDER_RESULTS
    ) {
      throw new ProviderRequestError(
        "provider candidate count is outside the supported range",
      );
    }
    return {
      stage: "discovery",
      candidates: value.candidates.map(validateCandidate),
      providerMeta: validateProviderMeta(value.providerMeta),
    };
  }
  if (value.stage === "offers") {
    exactKeys(
      value,
      ["offers", "providerMeta", "selectedProduct", "stage"],
      "provider offers payload",
    );
    if (
      !Array.isArray(value.offers) ||
      value.offers.length > MAX_PROVIDER_RESULTS
    ) {
      throw new ProviderRequestError(
        "provider offer count is outside the supported range",
      );
    }
    return {
      stage: "offers",
      selectedProduct: validateSelectedProduct(value.selectedProduct),
      offers: value.offers.map(validateOffer),
      providerMeta: validateProviderMeta(value.providerMeta),
    };
  }
  throw new ProviderRequestError("provider response stage is invalid");
}

function validateProviderPayload(value) {
  if (Array.isArray(value)) {
    return { stage: "legacy", results: validateProviderResults(value) };
  }
  return validateStructuredProviderPayload(value);
}

function parsePositiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,8}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * A key alone grants no paid call. Enablement, the total cent ceiling and a
 * conservative per-call cent reservation must all be explicit.
 */
export function createPaidCallBudgetFromEnvironment(env = {}) {
  const flag = env.SWL_PAID_CALLS_ENABLED;
  const ceilingCents = parsePositiveInteger(
    env.SWL_PROVIDER_COST_CEILING_CENTS,
  );
  const perCallCents = parsePositiveInteger(
    env.SWL_PROVIDER_COST_PER_CALL_CENTS,
  );
  const explicitlyDisabled =
    flag === undefined || flag === "" || flag === "false";
  const configurationValid =
    explicitlyDisabled ||
    (flag === "true" && ceilingCents !== null && perCallCents !== null);
  const enabled = flag === "true" && configurationValid;
  let reservedCents = 0;

  const status = () => ({
    enabled,
    state: !configurationValid
      ? "invalid"
      : !enabled
        ? "disabled"
        : reservedCents + perCallCents > ceilingCents
          ? "exhausted"
          : "enabled",
    ceilingCents: ceilingCents ?? 0,
    perCallCents: perCallCents ?? 0,
    reservedCents,
  });

  return {
    status,
    reserve() {
      const current = status();
      if (current.state !== "enabled") return current;
      reservedCents += perCallCents;
      return { ...status(), authorised: true };
    },
  };
}

/** Simple token bucket: `capacity` outbound provider calls per `windowMs`. */
export function createRateLimiter({
  capacity = 10,
  windowMs = 60_000,
  now = Date.now,
} = {}) {
  let tokens = capacity;
  let windowStart = now();
  return {
    tryTake() {
      const t = now();
      if (t - windowStart >= windowMs) {
        tokens = capacity;
        windowStart = t;
      }
      if (tokens <= 0) return false;
      tokens -= 1;
      return true;
    },
  };
}

/** In-memory response cache keyed by normalised query and selection token. */
export function createSearchCache({
  ttlMs = CACHE_TTL_MS,
  now = Date.now,
} = {}) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return null;
      if (now() - hit.storedAt > ttlMs) {
        entries.delete(key);
        return null;
      }
      return hit.value;
    },
    set(key, value) {
      entries.set(key, { value, storedAt: now() });
    },
  };
}

/** Lowest / median / highest across priced results, in integer cents. */
export function priceBandCents(results) {
  const priced = results.map((x) => x.priceCents).sort((a, b) => a - b);
  if (priced.length === 0) return null;
  const mid = Math.floor(priced.length / 2);
  const median =
    priced.length % 2 === 1
      ? priced[mid]
      : Number((BigInt(priced[mid - 1]) + BigInt(priced[mid]) + 1n) / 2n);
  return {
    lowestCents: priced[0],
    medianCents: median,
    highestCents: priced[priced.length - 1],
    lowest: centsToAmount(priced[0]),
    median: centsToAmount(median),
    highest: centsToAmount(priced[priced.length - 1]),
    pricedResults: priced.length,
  };
}

function coverage({
  provider,
  sourceDomains = [],
  providerCandidates = 0,
  parsedOffers = 0,
  comparableOffers = 0,
  excludedOffers = 0,
}) {
  return {
    providerQueried: provider,
    sourcesWithPrice: sourceDomains.length,
    sourceDomains,
    pricedResults: comparableOffers,
    providerCandidates,
    parsedOffers,
    comparableOffers,
    excludedOffers,
  };
}

function localCacheKey(normalised, candidateToken) {
  return candidateToken === null
    ? `discovery:${normalised.toLowerCase()}`
    : `offers:${normalised.toLowerCase()}:${candidateToken}`;
}

function providerDetail(providerMeta, prefix = "") {
  const notes = [];
  if (prefix) notes.push(prefix);
  if (providerMeta.storesMayContinue) {
    notes.push(
      "The provider reports additional offers beyond this bounded response.",
    );
  }
  if (providerMeta.cacheBasis === "provider_cache_allowed") {
    notes.push(
      "The provider may serve an identical request from its own cache.",
    );
  }
  return notes.join(" ");
}

function legacyOutcome(base, retrievedAt) {
  return {
    ...base,
    state: "provider_error",
    results: [],
    band: null,
    retrievedAt,
    cached: false,
    coverage: coverage({
      provider: base.provider,
      parsedOffers: 0,
      comparableOffers: 0,
      excludedOffers: 0,
    }),
    detail:
      "The provider returned a legacy item-price payload without a trusted selected product and structured delivered-price evidence.",
  };
}

function discoveryOutcome(base, payload, retrievedAt) {
  const candidates = payload.candidates;
  return {
    ...base,
    state: candidates.length === 0 ? "empty" : "selection_required",
    candidates,
    results: [],
    band: null,
    retrievedAt,
    cached: false,
    detail: providerDetail(
      payload.providerMeta,
      candidates.length > 0
        ? "Choose the exact product candidate before comparing merchant offers. This candidate list is bounded and is not exhaustive."
        : "No selectable product cluster was returned by this bounded search; this does not establish that the product is unavailable.",
    ),
    coverage: coverage({
      provider: base.provider,
      providerCandidates: candidates.length,
    }),
  };
}

function offersOutcome(base, payload, retrievedAt) {
  const results = payload.offers.map((item) => ({
    searchQuery: base.query,
    selectedProductTitle: payload.selectedProduct.title,
    selectedProductBrand: payload.selectedProduct.brand,
    selectedProductId: payload.selectedProduct.productId,
    title: item.title,
    priceCents: item.itemPriceCents,
    priceAud: centsToAmount(item.itemPriceCents),
    itemPriceCents: item.itemPriceCents,
    itemPriceAud: centsToAmount(item.itemPriceCents),
    shippingCents: item.shippingCents,
    shippingAud:
      item.shippingCents === null ? null : centsToAmount(item.shippingCents),
    estimatedTaxCents: item.estimatedTaxCents,
    estimatedTaxAud:
      item.estimatedTaxCents === null
        ? null
        : centsToAmount(item.estimatedTaxCents),
    totalPriceCents: item.totalPriceCents,
    totalPriceAud:
      item.totalPriceCents === null
        ? null
        : centsToAmount(item.totalPriceCents),
    comparisonPriceCents: item.comparisonPriceCents,
    comparisonPriceAud:
      item.comparisonPriceCents === null
        ? null
        : centsToAmount(item.comparisonPriceCents),
    priceBasis: item.priceBasis,
    originalPriceText: item.originalPriceText,
    currencyBasis: item.currencyBasis,
    currency: "AUD",
    gstBasis: item.gstBasis,
    packSize: item.packSize,
    condition: item.condition,
    availability: item.availability,
    financing: item.financing,
    comparisonEligible: item.comparisonEligible,
    exclusionReasons: item.exclusionReasons,
    seller: item.seller,
    sourceDomain: item.sourceDomain,
    url: item.url,
    retrievedAt,
  }));
  const comparable = results.filter((item) => item.comparisonEligible);
  const band = priceBandCents(
    comparable.map((item) => ({ priceCents: item.comparisonPriceCents })),
  );
  const sourceDomains = [...new Set(results.map((item) => item.sourceDomain))];
  const noComparable = comparable.length === 0;
  return {
    ...base,
    state: noComparable ? "no_comparable_offers" : "ok",
    selectedProduct: payload.selectedProduct,
    results,
    band,
    retrievedAt,
    cached: false,
    detail: providerDetail(
      payload.providerMeta,
      results.length === 0
        ? "No direct merchant offers matching the supported contract were returned. This does not establish that no merchant offers exist."
        : noComparable
          ? "Direct merchant offers were found, but none had an eligible comparison total. This bounded result is not exhaustive."
          : "This comparison covers only the returned direct merchant offers. It is not exhaustive.",
    ),
    coverage: coverage({
      provider: base.provider,
      sourceDomains,
      parsedOffers: results.length,
      comparableOffers: comparable.length,
      excludedOffers: results.length - comparable.length,
    }),
  };
}

export function createSearchService({
  provider,
  rateLimiter = createRateLimiter(),
  cache = createSearchCache(),
  paidCallBudget = createPaidCallBudgetFromEnvironment(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  clock = () => new Date().toISOString(),
}) {
  return {
    provider,
    async search(rawQuery, rawCandidateToken, rawSelectedCandidate) {
      const { normalised, kind, providerQuery } = buildProviderQuery(rawQuery);
      const base = {
        query: normalised,
        queryKind: kind,
        provider: provider.name,
        candidates: [],
      };
      const candidateToken =
        rawCandidateToken === undefined || rawCandidateToken === ""
          ? null
          : rawCandidateToken;
      const invalidQuery =
        kind === "empty" ||
        normalised.length > MAX_QUERY_CHARACTERS ||
        [...normalised].some((character) => {
          const codePoint = character.codePointAt(0);
          return (
            codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
          );
        });
      const invalidCandidateToken =
        candidateToken !== null &&
        !isBoundedProviderText(candidateToken, MAX_TOKEN_CHARACTERS);
      let selectedCandidate;
      try {
        if (rawSelectedCandidate !== undefined) {
          if (candidateToken === null) {
            throw new ProviderRequestError(
              "selected candidate requires a candidate token",
            );
          }
          selectedCandidate = validateCandidate(rawSelectedCandidate);
          if (selectedCandidate.token !== candidateToken) {
            throw new ProviderRequestError(
              "selected candidate token does not match",
            );
          }
        }
      } catch {
        return { ...base, state: "invalid_query", results: [], band: null };
      }
      if (invalidQuery || invalidCandidateToken) {
        return { ...base, state: "invalid_query", results: [], band: null };
      }
      if (!provider.configured) {
        return {
          ...base,
          state: "not_configured",
          results: [],
          band: null,
          detail:
            provider.requiresPaidCall === true
              ? "Live search is not configured. A provider credential plus explicit paid-call enablement, ceiling and per-call reservation are required."
              : "Live search is not configured. Configure the selected provider credentials in the local environment.",
        };
      }
      if (
        candidateToken !== null &&
        typeof provider.resolveCandidateSelection === "function"
      ) {
        try {
          selectedCandidate = provider.resolveCandidateSelection(
            providerQuery,
            {
              candidateToken,
              ...(selectedCandidate === undefined ? {} : { selectedCandidate }),
            },
          );
        } catch (error) {
          if (error instanceof ProviderSelectionExpiredError) {
            return {
              ...base,
              state: "selection_expired",
              results: [],
              band: null,
              detail:
                "The selected product is no longer available in this search session. Search again and reselect the product.",
            };
          }
          return {
            ...base,
            state: "provider_error",
            results: [],
            band: null,
            detail:
              error instanceof ProviderRequestError
                ? error.message
                : "The provider selection could not be validated safely.",
          };
        }
      }
      const cacheKey = localCacheKey(normalised, candidateToken);
      const cached = cache.get(cacheKey);
      if (cached) return { ...cached, cached: true };
      if (!rateLimiter.tryTake()) {
        return {
          ...base,
          state: "rate_limited",
          results: [],
          band: null,
          detail:
            "Outbound search rate limit reached. Retry in about a minute.",
        };
      }
      if (provider.requiresPaidCall === true) {
        const reservation = paidCallBudget.reserve();
        if (!reservation.authorised) {
          const exhausted = reservation.state === "exhausted";
          return {
            ...base,
            state: exhausted ? "quota_exhausted" : "not_configured",
            results: [],
            band: null,
            detail: exhausted
              ? "The configured local provider cost ceiling is exhausted."
              : "Paid provider calls are disabled. Explicit enablement, a positive cent ceiling and a positive per-call cent reservation are all required.",
          };
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let providerPayload;
      try {
        providerPayload = validateProviderPayload(
          await provider.search(providerQuery, {
            signal: controller.signal,
            ...(candidateToken === null ? {} : { candidateToken }),
            ...(selectedCandidate === undefined ? {} : { selectedCandidate }),
          }),
        );
        if (
          (candidateToken === null &&
            providerPayload.stage === "offers" &&
            provider.singleStageOffers !== true) ||
          (candidateToken !== null && providerPayload.stage === "discovery")
        ) {
          throw new ProviderRequestError("provider response stage is invalid");
        }
      } catch (error) {
        if (
          error instanceof ProviderTimeoutError ||
          error?.name === "AbortError"
        ) {
          return {
            ...base,
            state: "timeout",
            results: [],
            band: null,
            detail: error.message,
          };
        }
        if (error instanceof ProviderQuotaError) {
          return {
            ...base,
            state: "quota_exhausted",
            results: [],
            band: null,
            detail: error.message,
          };
        }
        if (error instanceof ProviderSelectionExpiredError) {
          return {
            ...base,
            state: "selection_expired",
            results: [],
            band: null,
            detail:
              "The selected product is no longer available in this search session. Search again and reselect the product.",
          };
        }
        const detail =
          error instanceof ProviderRequestError
            ? error.message
            : "The provider request failed without a safe diagnostic.";
        return {
          ...base,
          state: "provider_error",
          results: [],
          band: null,
          detail,
        };
      } finally {
        clearTimeout(timer);
      }

      const retrievedAt =
        providerPayload.stage === "legacy"
          ? clock()
          : (providerPayload.providerMeta.observedAt ?? clock());
      const outcome =
        providerPayload.stage === "legacy"
          ? legacyOutcome(base, retrievedAt)
          : providerPayload.stage === "discovery"
            ? discoveryOutcome(base, providerPayload, retrievedAt)
            : offersOutcome(base, providerPayload, retrievedAt);
      cache.set(cacheKey, outcome);
      return outcome;
    },
  };
}
