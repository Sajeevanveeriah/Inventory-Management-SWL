import { ProviderQuotaError, ProviderRequestError } from "./providerErrors.mjs";
import {
  amountToCents,
  boundedProviderText,
  configuredSecret,
  createStructuredOffer,
  displayProviderQuery,
  merchantUrl,
  readBoundedProviderJson,
} from "./freeProviderUtils.mjs";

const TOKEN_ENDPOINT = "https://api.ebay.com/identity/v1/oauth2/token";
const BROWSE_ENDPOINT =
  "https://api.ebay.com/buy/browse/v1/item_summary/search";
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
const MAX_ITEMS = 100;
const USER_AGENT =
  "SWL-Pricing-Inventory-Control/1.2.0 (competitor price research; contact: repository owner)";

function cheapestAudShipping(item) {
  if (!Array.isArray(item.shippingOptions)) return null;
  let lowest = null;
  for (const option of item.shippingOptions.slice(0, 20)) {
    if (
      !option ||
      typeof option !== "object" ||
      Array.isArray(option) ||
      option.shippingCost?.currency !== "AUD"
    ) {
      continue;
    }
    const cents = amountToCents(option.shippingCost.value);
    if (cents !== null && (lowest === null || cents < lowest)) lowest = cents;
  }
  return lowest;
}

function ebayOffer(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (item.price?.currency !== "AUD") return null;
  const title = boundedProviderText(item.title, 1_000) ? item.title : null;
  const sourceUrl = merchantUrl(item.itemWebUrl);
  const itemPriceCents = amountToCents(item.price.value);
  if (!title || !sourceUrl || itemPriceCents === null) return null;
  const seller = boundedProviderText(item.seller?.username, 512)
    ? item.seller.username
    : "eBay seller";
  const originalPriceText = `AUD ${item.price.value}`;
  if (!boundedProviderText(originalPriceText, 64)) return null;
  return createStructuredOffer({
    title,
    seller,
    url: sourceUrl.href,
    itemPriceCents,
    shippingCents: cheapestAudShipping(item),
    originalPriceText,
    currencyBasis: "explicit-aud",
    conditionText: boundedProviderText(item.condition, 256, true)
      ? item.condition
      : "",
    availabilityText: "available buy it now",
    financing: false,
  });
}

async function providerFetch(fetchImpl, url, options) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: "manual" });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ProviderRequestError("provider network request failed");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ProviderRequestError("provider redirect rejected");
  }
  if (response.status === 429) throw new ProviderQuotaError();
  if (!response.ok) throw new ProviderRequestError(`HTTP ${response.status}`);
  return readBoundedProviderJson(response);
}

export function createEbayBrowseProvider(
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
) {
  const clientId = configuredSecret(env.EBAY_CLIENT_ID)
    ? env.EBAY_CLIENT_ID
    : "";
  const clientSecret = configuredSecret(env.EBAY_CLIENT_SECRET)
    ? env.EBAY_CLIENT_SECRET
    : "";
  const marketplace = env.EBAY_MARKETPLACE_ID ?? "EBAY_AU";
  const configured =
    clientId !== "" && clientSecret !== "" && marketplace === "EBAY_AU";
  let token = null;

  async function applicationToken(signal) {
    if (token && token.expiresAt > now() + 30_000) return token.value;
    const credentials = Buffer.from(
      `${clientId}:${clientSecret}`,
      "utf8",
    ).toString("base64");
    const body = await providerFetch(fetchImpl, TOKEN_ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        accept: "application/json",
        authorization: `Basic ${credentials}`,
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: OAUTH_SCOPE,
      }).toString(),
    });
    if (
      !boundedProviderText(body?.access_token, 8_192) ||
      !Number.isSafeInteger(body?.expires_in) ||
      body.expires_in <= 0 ||
      body.expires_in > 86_400
    ) {
      throw new ProviderRequestError("OAuth token response is invalid");
    }
    token = {
      value: body.access_token,
      expiresAt: now() + Math.max(1, body.expires_in - 60) * 1_000,
    };
    return token.value;
  }

  return {
    name: "ebay-browse-au",
    requiresPaidCall: false,
    singleStageOffers: true,
    configured,
    capabilities: {
      id: "ebay-browse-au",
      displayName: "eBay Browse AU",
      mode: "single-stage-structured-offers",
      authentication: "OAuth application credentials",
      configured,
      quota: { kind: "official-api-quota" },
      limits: { concurrency: 1, requestsPerMinute: 10 },
      cache: { ttlSeconds: 900, persistent: false },
      health: configured ? "unknown" : "not-configured",
      lastSuccess: null,
      lastErrorCategory: null,
      dataRights: "Official Browse API and EBAY_AU marketplace terms apply.",
      supportedIdentityFields: ["gtin", "mpn", "brand", "model", "title"],
    },
    async search(providerQuery, { signal } = {}) {
      const selectedTitle = displayProviderQuery(providerQuery);
      if (!configured) {
        throw new ProviderRequestError(
          "EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are not configured for EBAY_AU",
        );
      }
      if (!selectedTitle) {
        throw new ProviderRequestError("provider query is invalid");
      }
      const accessToken = await applicationToken(signal);
      const url = new URL(BROWSE_ENDPOINT);
      url.searchParams.set("q", providerQuery);
      url.searchParams.set("limit", "50");
      const body = await providerFetch(fetchImpl, url, {
        method: "GET",
        signal,
        headers: {
          accept: "application/json",
          "accept-language": "en-AU",
          authorization: `Bearer ${accessToken}`,
          "user-agent": USER_AGENT,
          "x-ebay-c-marketplace-id": marketplace,
        },
      });
      const rows = body?.itemSummaries;
      if (!Array.isArray(rows) || rows.length > MAX_ITEMS) {
        throw new ProviderRequestError("provider result collection is invalid");
      }
      const offers = [];
      const seen = new Set();
      for (const row of rows) {
        const offer = ebayOffer(row);
        if (!offer || seen.has(offer.url)) continue;
        seen.add(offer.url);
        offers.push(offer);
      }
      return {
        stage: "offers",
        selectedProduct: {
          title: selectedTitle,
          brand: null,
          productId: null,
        },
        offers,
        providerMeta: {
          observedAt: null,
          cacheBasis: "provider_cache_bypassed",
          storesMayContinue: boundedProviderText(body?.next, 2_048),
        },
      };
    },
  };
}
