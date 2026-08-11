import { ProviderQuotaError, ProviderRequestError } from "./providerErrors.mjs";
import {
  amountToCents,
  boundedProviderText,
  configuredSecret,
  createStructuredOffer,
  displayProviderQuery,
  merchantUrl,
  readBoundedProviderJson,
  shippingTextToCents,
} from "./freeProviderUtils.mjs";

const ENDPOINT = "https://google.serper.dev/shopping";
const MAX_ITEMS = 100;
const USER_AGENT =
  "SWL-Pricing-Inventory-Control/1.2.0 (competitor price research; contact: repository owner)";

function serperShippingCents(item) {
  const numeric = amountToCents(
    item.shippingCost ?? item.shipping_cost ?? item.extracted_shipping,
  );
  if (numeric !== null) return numeric;
  for (const candidate of [item.delivery, item.shipping, item.deliveryInfo]) {
    const cents = shippingTextToCents(candidate);
    if (cents !== null) return cents;
  }
  return null;
}

function serperOffer(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const title = boundedProviderText(item.title, 1_000) ? item.title : null;
  const sourceUrl = merchantUrl(item.link);
  const itemPriceCents = amountToCents(
    item.extractedPrice ?? item.extracted_price ?? item.price,
  );
  if (!title || !sourceUrl || itemPriceCents === null) return null;
  const seller = boundedProviderText(item.source, 512)
    ? item.source
    : sourceUrl.hostname;
  const originalPriceText = boundedProviderText(item.price, 64)
    ? item.price
    : `A$${(itemPriceCents / 100).toFixed(2)}`;
  return createStructuredOffer({
    title,
    seller,
    url: sourceUrl.href,
    itemPriceCents,
    shippingCents: serperShippingCents(item),
    originalPriceText,
    currencyBasis: "inferred-au-localisation",
    conditionText: boundedProviderText(item.condition, 256, true)
      ? item.condition
      : "",
    availabilityText: boundedProviderText(item.availability, 512, true)
      ? item.availability
      : "",
    financing:
      item.installment !== undefined || item.installments !== undefined,
  });
}

export function createSerperShoppingProvider(
  env = process.env,
  fetchImpl = fetch,
) {
  const apiKey = configuredSecret(env.SERPER_API_KEY) ? env.SERPER_API_KEY : "";
  return {
    name: "serper-shopping-au",
    requiresPaidCall: false,
    singleStageOffers: true,
    configured: apiKey !== "",
    capabilities: {
      id: "serper-shopping-au",
      displayName: "Serper Shopping AU",
      mode: "single-stage-structured-offers",
      authentication: "API key",
      configured: apiKey !== "",
      quota: { kind: "finite-free-credit" },
      limits: { concurrency: 1, requestsPerMinute: 10 },
      cache: { ttlSeconds: 900, persistent: false },
      health: apiKey === "" ? "not-configured" : "unknown",
      lastSuccess: null,
      lastErrorCategory: null,
      dataRights: "Finite provider credits and source-site terms apply.",
      supportedIdentityFields: ["gtin", "mpn", "brand", "model", "title"],
    },
    async search(providerQuery, { signal } = {}) {
      const selectedTitle = displayProviderQuery(providerQuery);
      if (apiKey === "") {
        throw new ProviderRequestError("SERPER_API_KEY is not configured");
      }
      if (!selectedTitle) {
        throw new ProviderRequestError("provider query is invalid");
      }
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: "POST",
          redirect: "manual",
          signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "user-agent": USER_AGENT,
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            q: providerQuery,
            gl: "au",
            hl: "en",
            num: 20,
          }),
        });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        throw new ProviderRequestError("provider network request failed");
      }
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderRequestError("provider redirect rejected");
      }
      if (response.status === 429) throw new ProviderQuotaError();
      if (!response.ok) {
        throw new ProviderRequestError(`HTTP ${response.status}`);
      }
      const body = await readBoundedProviderJson(response);
      const rows = body?.shopping;
      if (!Array.isArray(rows) || rows.length > MAX_ITEMS) {
        throw new ProviderRequestError("provider result collection is invalid");
      }
      const offers = [];
      const seen = new Set();
      for (const row of rows) {
        const offer = serperOffer(row);
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
          storesMayContinue: false,
        },
      };
    },
  };
}
