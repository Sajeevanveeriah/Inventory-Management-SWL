import { centsToAmount } from '../lib/moneyCents.mjs';
import { buildProviderQuery } from './normaliseQuery.mjs';
import {
  ProviderQuotaError,
  ProviderRequestError,
  ProviderTimeoutError,
} from './fixtureProvider.mjs';

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

/** Simple token bucket: `capacity` outbound provider calls per `windowMs`. */
export function createRateLimiter({ capacity = 10, windowMs = 60_000, now = Date.now } = {}) {
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
export function createSearchCache({ ttlMs = CACHE_TTL_MS, now = Date.now } = {}) {
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
  timeoutMs = DEFAULT_TIMEOUT_MS,
  clock = () => new Date().toISOString(),
}) {
  return {
    provider,
    async search(rawQuery) {
      const { normalised, kind, providerQuery } = buildProviderQuery(rawQuery);
      const base = { query: normalised, queryKind: kind, provider: provider.name };
      if (kind === 'empty') return { ...base, state: 'invalid_query', results: [], band: null };
      if (!provider.configured) {
        return {
          ...base,
          state: 'not_configured',
          results: [],
          band: null,
          detail:
            'Live search is not configured. Set SERPAPI_KEY in the server environment (see .env.example) and restart the server.',
        };
      }
      const cached = cache.get(normalised.toLowerCase());
      if (cached) return { ...cached, cached: true };
      if (!rateLimiter.tryTake()) {
        return {
          ...base,
          state: 'rate_limited',
          results: [],
          band: null,
          detail: 'Outbound search rate limit reached. Retry in about a minute.',
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let providerResults;
      try {
        providerResults = await provider.search(providerQuery, { signal: controller.signal });
      } catch (error) {
        if (error instanceof ProviderTimeoutError || error?.name === 'AbortError') {
          return { ...base, state: 'timeout', results: [], band: null, detail: error.message };
        }
        if (error instanceof ProviderQuotaError) {
          return {
            ...base,
            state: 'quota_exhausted',
            results: [],
            band: null,
            detail: error.message,
          };
        }
        const detail =
          error instanceof ProviderRequestError ? error.message : String(error?.message ?? error);
        return { ...base, state: 'provider_error', results: [], band: null, detail };
      } finally {
        clearTimeout(timer);
      }
      const retrievedAt = clock();
      const results = providerResults.map((item) => ({
        ...item,
        priceAud: centsToAmount(item.priceCents),
        currency: 'AUD',
        retrievedAt,
      }));
      const sourceDomains = [...new Set(results.map((x) => x.sourceDomain))];
      const outcome = {
        ...base,
        state: results.length === 0 ? 'empty' : 'ok',
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
