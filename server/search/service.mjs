import { centsToAmount } from "../lib/moneyCents.mjs";
import { buildProviderQuery } from "./normaliseQuery.mjs";
import {
  ProviderQuotaError,
  ProviderRequestError,
  ProviderTimeoutError,
} from "./fixtureProvider.mjs";

/**
 * Live search orchestration: rate limit -> cache -> provider, with the five
 * failure conditions kept distinct end to end. The client renders each state
 * differently; nothing collapses into a blank screen.
 *
 * States: ok | empty | not_configured | timeout | provider_error |
 *         quota_exhausted | rate_limited | invalid_query
 */

const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_QUERY_CHARACTERS = 512;
const MAX_PROVIDER_RESULTS = 100;
const MAX_CENTS = 1_000_000_000;

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
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ProviderRequestError("provider result is invalid");
    }
    const keys = Object.keys(item).sort();
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key, index) => key !== expectedKeys[index])
    ) {
      throw new ProviderRequestError(
        "provider result contains unsupported fields",
      );
    }
    if (
      !isBoundedProviderText(item.title, 1_000) ||
      !Number.isSafeInteger(item.priceCents) ||
      item.priceCents < 0 ||
      item.priceCents > MAX_CENTS ||
      !["inc-gst", "ex-gst", "unknown"].includes(item.gstBasis) ||
      (item.packSize !== null &&
        !isBoundedProviderText(item.packSize, 256, true)) ||
      !isBoundedProviderText(item.seller, 512) ||
      !isBoundedProviderText(item.sourceDomain, 253) ||
      !isBoundedProviderText(item.url, 2_048)
    ) {
      throw new ProviderRequestError(
        "provider result is outside the supported range",
      );
    }
    let sourceUrl;
    try {
      sourceUrl = new URL(item.url);
    } catch {
      throw new ProviderRequestError("provider result URL is invalid");
    }
    if (
      sourceUrl.protocol !== "https:" ||
      sourceUrl.hostname === "" ||
      sourceUrl.username !== "" ||
      sourceUrl.password !== "" ||
      sourceUrl.hostname.toLowerCase() !== item.sourceDomain.toLowerCase()
    ) {
      throw new ProviderRequestError(
        "provider result URL is outside the approved boundary",
      );
    }
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

function parsePositiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,8}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * A key alone grants no paid call. Enablement, the total cent ceiling and a
 * conservative per-call cent reservation must all be explicit. Reservations
 * are process-local and pessimistically consumed before a provider request
 * because a failed call may still incur cost.
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

/** In-memory response cache keyed by the normalised query. */
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
    async search(rawQuery) {
      const { normalised, kind, providerQuery } = buildProviderQuery(rawQuery);
      const base = {
        query: normalised,
        queryKind: kind,
        provider: provider.name,
      };
      if (
        kind === "empty" ||
        normalised.length > MAX_QUERY_CHARACTERS ||
        [...normalised].some((character) => {
          const codePoint = character.codePointAt(0);
          return (
            codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
          );
        })
      )
        return { ...base, state: "invalid_query", results: [], band: null };
      if (!provider.configured) {
        return {
          ...base,
          state: "not_configured",
          results: [],
          band: null,
          detail:
            "Live search is not configured. A provider credential plus explicit paid-call enablement, ceiling and per-call reservation are required.",
        };
      }
      const cached = cache.get(normalised.toLowerCase());
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
      let providerResults;
      try {
        providerResults = validateProviderResults(
          await provider.search(providerQuery, {
            signal: controller.signal,
          }),
        );
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
      const retrievedAt = clock();
      const results = providerResults.map((item) => ({
        title: item.title,
        priceCents: item.priceCents,
        gstBasis: item.gstBasis,
        packSize: item.packSize,
        seller: item.seller,
        sourceDomain: item.sourceDomain,
        url: item.url,
        priceAud: centsToAmount(item.priceCents),
        currency: "AUD",
        retrievedAt,
      }));
      const sourceDomains = [...new Set(results.map((x) => x.sourceDomain))];
      const outcome = {
        ...base,
        state: results.length === 0 ? "empty" : "ok",
        results,
        band: priceBandCents(results),
        retrievedAt,
        cached: false,
        coverage: {
          providerQueried: provider.name,
          sourcesWithPrice: sourceDomains.length,
          sourceDomains,
          pricedResults: results.length,
        },
      };
      cache.set(normalised.toLowerCase(), outcome);
      return outcome;
    },
  };
}
