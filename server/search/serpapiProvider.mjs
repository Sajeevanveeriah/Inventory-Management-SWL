import { TextDecoder } from "node:util";
import { parseAmountToCents } from "../lib/moneyCents.mjs";
import {
  ProviderQuotaError,
  ProviderRequestError,
  ProviderTimeoutError,
} from "./fixtureProvider.mjs";

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

const ENDPOINT = "https://serpapi.com/search.json";
const ALLOWED_PROVIDER_HOST = "serpapi.com";
export const MAX_PROVIDER_RESPONSE_BYTES = 1_048_576;
const MAX_PROVIDER_ITEMS = 100;
const USER_AGENT =
  "SWL-Pricing-Inventory-Control/1.1.0 (competitor price research; contact: repository owner)";

/** Extract "pack of N" / "box of N" / "N pack" wording from a product title. */
export function packSizeFromTitle(title) {
  const m =
    /\b(?:pack|box|carton|bag|set)\s+of\s+(\d{1,4})\b/i.exec(title) ??
    /\b(\d{1,4})\s*(?:pack|pk)\b/i.exec(title);
  if (!m) return null;
  const source = m[0].toLowerCase();
  return source.includes("of") ? source : `pack of ${m[1]}`;
}

/** Parse a SerpAPI price into integer cents, accepting "$12.34" / "A$12.34" / 12.34. */
export function serpPriceToCents(item) {
  if (
    typeof item.extracted_price === "number" &&
    Number.isFinite(item.extracted_price)
  ) {
    // Provider float is converted once at the boundary via fixed string form;
    // all arithmetic after this point is integer cents.
    return parseAmountToCents(item.extracted_price.toFixed(2));
  }
  if (typeof item.price === "string") {
    const cleaned = item.price
      .replace(/^(aud|au\$|a\$|\$)\s*/i, "")
      .replace(/,/g, "");
    return parseAmountToCents(cleaned);
  }
  return null;
}

async function readBoundedJson(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new ProviderRequestError("response content type is not JSON");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (
      !/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES
    ) {
      throw new ProviderRequestError(
        "response size is outside the supported range",
      );
    }
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new ProviderRequestError("response body is unavailable");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProviderRequestError(
          "response size is outside the supported range",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProviderRequestError("response JSON is invalid");
  }
}

function boundedProviderText(value, max, allowEmpty = false) {
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

function normaliseProviderItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const title = typeof item.title === "string" ? item.title : "";
  if (!boundedProviderText(title, 1_000)) return null;
  const priceCents = serpPriceToCents(item);
  if (
    !Number.isSafeInteger(priceCents) ||
    priceCents < 0 ||
    priceCents > 1_000_000_000
  ) {
    return null;
  }
  const seller = typeof item.source === "string" ? item.source : "";
  if (!boundedProviderText(seller, 512)) return null;
  const rawUrl = typeof item.link === "string" ? item.link : item.product_link;
  if (!boundedProviderText(rawUrl, 2_048)) return null;
  let sourceUrl;
  try {
    sourceUrl = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    sourceUrl.protocol !== "https:" ||
    sourceUrl.hostname === "" ||
    sourceUrl.username !== "" ||
    sourceUrl.password !== ""
  ) {
    return null;
  }
  const sourceDomain = sourceUrl.hostname.toLowerCase();
  if (!boundedProviderText(sourceDomain, 253)) return null;
  return {
    title,
    priceCents,
    gstBasis: "unknown",
    packSize: packSizeFromTitle(title),
    seller,
    sourceDomain,
    url: sourceUrl.href,
  };
}

export function createSerpApiProvider(env = process.env, fetchImpl = fetch) {
  const apiKey = env.SERPAPI_KEY ?? "";
  return {
    name: "serpapi-google-shopping-au",
    requiresPaidCall: true,
    configured: apiKey !== "",
    capabilities: {
      id: "serpapi-google-shopping-au",
      displayName: "SerpAPI Google Shopping AU",
      mode: "structured-offers",
      authentication: "API key",
      configured: apiKey !== "",
      quota: { kind: "provider-plan" },
      limits: { concurrency: 1, requestsPerMinute: 10 },
      cache: { ttlSeconds: 900, persistent: false },
      health: apiKey === "" ? "not-configured" : "unknown",
      lastSuccess: null,
      lastErrorCategory: null,
      dataRights:
        "Licensed intermediary terms and source-site rights remain the operator responsibility.",
      supportedIdentityFields: ["gtin", "mpn", "brand", "model", "title"],
    },
    async search(providerQuery, { signal } = {}) {
      if (apiKey === "")
        throw new ProviderRequestError("SERPAPI_KEY is not configured");
      const params = new URLSearchParams({
        engine: "google_shopping",
        q: providerQuery,
        google_domain: "google.com.au",
        gl: "au",
        hl: "en",
        location: "Australia",
        num: "20",
        api_key: apiKey,
      });
      const requestUrl = new URL(ENDPOINT);
      if (
        requestUrl.protocol !== "https:" ||
        requestUrl.hostname !== ALLOWED_PROVIDER_HOST ||
        requestUrl.username !== "" ||
        requestUrl.password !== ""
      ) {
        throw new ProviderRequestError(
          "provider endpoint is outside the allowlist",
        );
      }
      requestUrl.search = params.toString();
      let response;
      try {
        response = await fetchImpl(requestUrl.href, {
          signal,
          redirect: "manual",
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
        });
      } catch (error) {
        if (error?.name === "AbortError" || error?.name === "TimeoutError")
          throw new ProviderTimeoutError();
        throw new ProviderRequestError("network request failed");
      }
      if (response.url) {
        let responseUrl;
        try {
          responseUrl = new URL(response.url);
        } catch {
          throw new ProviderRequestError("provider response URL is invalid");
        }
        if (
          responseUrl.protocol !== "https:" ||
          responseUrl.hostname !== ALLOWED_PROVIDER_HOST ||
          responseUrl.username !== "" ||
          responseUrl.password !== ""
        ) {
          throw new ProviderRequestError(
            "provider response escaped the host allowlist",
          );
        }
      }
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderRequestError("provider redirect rejected");
      }
      if (response.status === 429) throw new ProviderQuotaError();
      if (!response.ok)
        throw new ProviderRequestError(`HTTP ${response.status}`);
      const body = await readBoundedJson(response);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ProviderRequestError("provider response shape is invalid");
      }
      if (body.error) {
        if (/run out of searches|quota/i.test(String(body.error)))
          throw new ProviderQuotaError();
        throw new ProviderRequestError("provider reported a request error");
      }
      const items = Array.isArray(body.shopping_results)
        ? body.shopping_results
        : [];
      if (items.length > MAX_PROVIDER_ITEMS) {
        throw new ProviderRequestError(
          "provider result count is outside the supported range",
        );
      }
      return items.flatMap((item) => {
        const normalised = normaliseProviderItem(item);
        return normalised ? [normalised] : [];
      });
    },
  };
}
