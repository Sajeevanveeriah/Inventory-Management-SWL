import { parseAmountToCents } from '../lib/moneyCents.mjs';
import {
  ProviderQuotaError,
  ProviderRequestError,
  ProviderTimeoutError,
} from './fixtureProvider.mjs';

/**
 * Real retrieval layer: Google Shopping results via the SerpAPI licensed SERP
 * API (https://serpapi.com). No retailer website is scraped directly; SerpAPI
 * is the licensed intermediary. The key is read from the environment and is
 * never logged or echoed back to the client.
 *
 * Australian bias: google.com.au domain, gl=au, hl=en, location Australia.
 * Prices are requested in AUD. GST basis is reported as "unknown" unless the
 * provider states tax treatment explicitly; Australian shelf prices normally
 * include GST, but that convention is not proof, so it is never asserted.
 */

const ENDPOINT = 'https://serpapi.com/search.json';
const USER_AGENT =
  'SWL-Pricing-Inventory-Control/1.0 (competitor price research; contact: repository owner)';

/** Extract "pack of N" / "box of N" / "N pack" wording from a product title. */
export function packSizeFromTitle(title) {
  const m =
    /\b(?:pack|box|carton|bag|set)\s+of\s+(\d{1,4})\b/i.exec(title) ??
    /\b(\d{1,4})\s*(?:pack|pk)\b/i.exec(title);
  if (!m) return null;
  const source = m[0].toLowerCase();
  return source.includes('of') ? source : `pack of ${m[1]}`;
}

/** Parse a SerpAPI price into integer cents, accepting "$12.34" / "A$12.34" / 12.34. */
export function serpPriceToCents(item) {
  if (typeof item.extracted_price === 'number' && Number.isFinite(item.extracted_price)) {
    // Provider float is converted once at the boundary via fixed string form;
    // all arithmetic after this point is integer cents.
    return parseAmountToCents(item.extracted_price.toFixed(2));
  }
  if (typeof item.price === 'string') {
    const cleaned = item.price.replace(/^(aud|au\$|a\$|\$)\s*/i, '').replace(/,/g, '');
    return parseAmountToCents(cleaned);
  }
  return null;
}

export function createSerpApiProvider(env = process.env, fetchImpl = fetch) {
  const apiKey = env.SERPAPI_KEY ?? '';
  return {
    name: 'serpapi-google-shopping-au',
    configured: apiKey !== '',
    capabilities: {
      id: 'serpapi-google-shopping-au',
      displayName: 'SerpAPI Google Shopping AU',
      mode: 'structured-offers',
      authentication: 'API key',
      configured: apiKey !== '',
      quota: { kind: 'provider-plan' },
      limits: { concurrency: 1, requestsPerMinute: 10 },
      cache: { ttlSeconds: 900, persistent: false },
      health: apiKey === '' ? 'not-configured' : 'unknown',
      lastSuccess: null,
      lastErrorCategory: null,
      dataRights:
        'Licensed intermediary terms and source-site rights remain the operator responsibility.',
      supportedIdentityFields: ['gtin', 'mpn', 'brand', 'model', 'title'],
    },
    async search(providerQuery, { signal } = {}) {
      if (apiKey === '') throw new ProviderRequestError('SERPAPI_KEY is not configured');
      const params = new URLSearchParams({
        engine: 'google_shopping',
        q: providerQuery,
        google_domain: 'google.com.au',
        gl: 'au',
        hl: 'en',
        location: 'Australia',
        num: '20',
        api_key: apiKey,
      });
      let response;
      try {
        response = await fetchImpl(`${ENDPOINT}?${params.toString()}`, {
          signal,
          headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        });
      } catch (error) {
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError')
          throw new ProviderTimeoutError();
        throw new ProviderRequestError(String(error?.message ?? error));
      }
      if (response.status === 429) throw new ProviderQuotaError();
      if (!response.ok) throw new ProviderRequestError(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) {
        if (/run out of searches|quota/i.test(String(body.error))) throw new ProviderQuotaError();
        throw new ProviderRequestError(String(body.error));
      }
      const items = Array.isArray(body.shopping_results) ? body.shopping_results : [];
      return items.flatMap((item) => {
        const priceCents = serpPriceToCents(item);
        if (priceCents === null || !item.title) return [];
        let sourceDomain = String(item.source ?? '').toLowerCase();
        try {
          if (item.link) sourceDomain = new URL(item.link).hostname;
        } catch {
          /* keep the provider-reported source name */
        }
        return [
          {
            title: String(item.title),
            priceCents,
            gstBasis: 'unknown',
            packSize: packSizeFromTitle(String(item.title)),
            seller: String(item.source ?? sourceDomain ?? 'unknown seller'),
            sourceDomain,
            url: String(item.link ?? item.product_link ?? ''),
          },
        ];
      });
    },
  };
}
