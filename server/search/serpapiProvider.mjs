import { TextDecoder } from "node:util";
import { parseAmountToCents } from "../lib/moneyCents.mjs";
import {
  ProviderQuotaError,
  ProviderRequestError,
  ProviderSelectionExpiredError,
  ProviderTimeoutError,
} from "./providerErrors.mjs";

/**
 * SerpAPI is used in two distinct stages. Google Shopping discovers product
 * clusters. An opaque cluster token then drives Google Immersive Product,
 * whose stores collection contains direct merchant offers. A discovery row is
 * never represented as a merchant observation.
 */

const ENDPOINT = "https://serpapi.com/search.json";
const ALLOWED_PROVIDER_HOST = "serpapi.com";
const DEFAULT_LOCATION = "Geelong, Victoria, Australia";
export const MAX_PROVIDER_RESPONSE_BYTES = 1_048_576;
const MAX_PROVIDER_ITEMS = 100;
const MAX_CENTS = 1_000_000_000;
const MAX_TOKEN_CHARACTERS = 8_192;
const MAX_REMEMBERED_CANDIDATES = 500;
const REMEMBERED_CANDIDATE_TTL_MS = 15 * 60 * 1_000;
const COMPONENT_CONFLICT = Symbol("component-conflict");
const USER_AGENT =
  "SWL-Pricing-Inventory-Control/1.2.0 (competitor price research; contact: repository owner)";

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

function validCents(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS;
}

function numericAmountToCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return parseAmountToCents(value.toFixed(2));
}

function textAmountToCents(value, { allowFree = false } = {}) {
  if (!boundedProviderText(value, 64)) return null;
  const trimmed = value.trim();
  if (allowFree && /^free(?:\s+(?:delivery|shipping))?$/iu.test(trimmed)) {
    return 0;
  }
  const cleaned = trimmed
    .replace(/^\+\s*/u, "")
    .replace(/^(?:aud|au\$|a\$|\$)\s*/iu, "")
    .replace(/,/gu, "");
  if (cleaned === trimmed && !/^\+\s*/u.test(trimmed)) return null;
  return parseAmountToCents(cleaned);
}

function componentToCents(extracted, text, options) {
  const hasExtracted = extracted !== undefined && extracted !== null;
  const hasText = text !== undefined && text !== null;
  const extractedCents = numericAmountToCents(extracted);
  const textCents = textAmountToCents(text, options);
  if (hasExtracted && hasText) {
    return validCents(extractedCents) &&
      validCents(textCents) &&
      extractedCents === textCents
      ? extractedCents
      : COMPONENT_CONFLICT;
  }
  if (validCents(extractedCents)) return extractedCents;
  return validCents(textCents) ? textCents : null;
}

/** Extract "pack of N" / "box of N" / "N pack" wording from a product title. */
export function packSizeFromTitle(title) {
  const m =
    /\b(?:pack|box|carton|bag|set)\s+of\s+(\d{1,4})\b/iu.exec(title) ??
    /\b(\d{1,4})\s*(?:pack|pk)\b/iu.exec(title);
  if (!m) return null;
  return `pack of ${m[1]}`;
}

/** Parse a SerpAPI price into integer cents. */
export function serpPriceToCents(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const cents = componentToCents(item.extracted_price, item.price);
  return validCents(cents) ? cents : null;
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

function providerTimestamp(value) {
  if (!boundedProviderText(value, 64)) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC$/u.exec(
    value,
  );
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString() !== iso
    ? null
    : iso;
}

function providerMeta(body, storesMayContinue) {
  const metadata = body.search_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ProviderRequestError("provider metadata is invalid");
  }
  if (metadata.status !== "Success") {
    throw new ProviderRequestError("provider search did not complete");
  }
  const observedAt =
    providerTimestamp(metadata.processed_at) ??
    providerTimestamp(metadata.created_at);
  return {
    observedAt,
    cacheBasis:
      body.search_parameters?.no_cache === true
        ? "provider_cache_bypassed"
        : "provider_cache_allowed",
    storesMayContinue,
  };
}

function normaliseAuLocation(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_LOCATION;
  }
  if (!boundedProviderText(value, 256)) return null;
  const parts = value.split(",").map((part) => part.trim());
  if (
    parts.length < 3 ||
    parts.some((part) => part === "") ||
    parts.at(-1)?.toLowerCase() !== "australia"
  ) {
    return null;
  }
  return parts.join(", ");
}

function normaliseHttpsUrl(value) {
  if (!boundedProviderText(value, 2_048)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return null;
  }
  return parsed;
}

function googleProductUrl(value) {
  const parsed = normaliseHttpsUrl(value);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  const approved =
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "google.com.au" ||
    host.endsWith(".google.com.au");
  if (!approved) return null;
  parsed.hostname = host;
  return parsed.href;
}

function directMerchantUrl(value) {
  const parsed = normaliseHttpsUrl(value);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  const intermediary =
    host === ALLOWED_PROVIDER_HOST ||
    host.endsWith(`.${ALLOWED_PROVIDER_HOST}`) ||
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "google.com.au" ||
    host.endsWith(".google.com.au") ||
    host === "googleadservices.com" ||
    host.endsWith(".googleadservices.com");
  if (intermediary) return null;
  parsed.hostname = host;
  parsed.hash = "";
  return parsed;
}

function conditionFromText(value) {
  if (!boundedProviderText(value, 256)) return "unknown";
  if (/\b(?:used|refurbished|pre[- ]owned|second[- ]hand)\b/iu.test(value)) {
    return "used";
  }
  return /\bnew\b/iu.test(value) ? "new" : "unknown";
}

function candidateCondition(item, title) {
  if (boundedProviderText(item.second_hand_condition, 256)) return "used";
  return conditionFromText(title);
}

function normaliseCandidate(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (!boundedProviderText(item.title, 1_000)) return null;
  if (
    !boundedProviderText(
      item.immersive_product_page_token,
      MAX_TOKEN_CHARACTERS,
    )
  ) {
    return null;
  }
  const productUrl = googleProductUrl(item.product_link);
  if (!productUrl) return null;
  if (
    !Number.isSafeInteger(item.position) ||
    item.position < 0 ||
    item.position > 10_000
  ) {
    return null;
  }
  const priceCents = serpPriceToCents(item);
  const title = item.title;
  return {
    token: item.immersive_product_page_token,
    title,
    brand: boundedProviderText(item.brand, 256) ? item.brand : null,
    productId: boundedProviderText(item.product_id, 256)
      ? item.product_id
      : null,
    productUrl,
    displayedPrice: boundedProviderText(item.price, 64) ? item.price : null,
    priceCents: validCents(priceCents) ? priceCents : null,
    multipleSources: item.multiple_sources === true,
    packSize: packSizeFromTitle(title),
    condition: candidateCondition(item, title),
    position: item.position,
  };
}

function checkedArray(object, key) {
  if (!(key in object)) return [];
  if (!Array.isArray(object[key]) || object[key].length > MAX_PROVIDER_ITEMS) {
    throw new ProviderRequestError(
      "provider result count is outside the supported range",
    );
  }
  return object[key];
}

function shoppingRows(body) {
  const rows = [
    ...checkedArray(body, "shopping_results"),
    ...checkedArray(body, "inline_shopping_results"),
  ];
  for (const category of checkedArray(body, "categorized_shopping_results")) {
    if (!category || typeof category !== "object" || Array.isArray(category)) {
      throw new ProviderRequestError(
        "categorized shopping results are invalid",
      );
    }
    rows.push(...checkedArray(category, "shopping_results"));
    if (rows.length > MAX_PROVIDER_ITEMS) {
      throw new ProviderRequestError(
        "provider result count is outside the supported range",
      );
    }
  }
  if (rows.length > MAX_PROVIDER_ITEMS) {
    throw new ProviderRequestError(
      "provider result count is outside the supported range",
    );
  }
  return rows;
}

function canonicalProviderQuery(value) {
  return boundedProviderText(value, 1_024)
    ? value.trim().replace(/\s+/gu, " ").toLowerCase()
    : null;
}

function validateDiscoveryParameters(body, expectedLocation, expectedQuery) {
  const parameters = body.search_parameters;
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters) ||
    parameters.engine !== "google_shopping"
  ) {
    throw new ProviderRequestError("shopping response parameters are invalid");
  }
  for (const [key, expected] of [
    ["google_domain", "google.com.au"],
    ["gl", "au"],
    ["hl", "en"],
    ["device", "desktop"],
    ["location", expectedLocation],
  ]) {
    if (key in parameters && parameters[key] !== expected) {
      throw new ProviderRequestError(
        "shopping response localisation is invalid",
      );
    }
  }
  if (
    "q" in parameters &&
    canonicalProviderQuery(parameters.q) !==
      canonicalProviderQuery(expectedQuery)
  ) {
    throw new ProviderRequestError("shopping response query is invalid");
  }
}

function discoveryPayload(body, expectedLocation, expectedQuery) {
  validateDiscoveryParameters(body, expectedLocation, expectedQuery);
  const seen = new Set();
  const candidates = [];
  for (const item of shoppingRows(body)) {
    const candidate = normaliseCandidate(item);
    if (!candidate || seen.has(candidate.token)) continue;
    seen.add(candidate.token);
    candidates.push(candidate);
  }
  return {
    stage: "discovery",
    candidates,
    providerMeta: providerMeta(body, false),
  };
}

function currencyBasis(priceText) {
  if (!boundedProviderText(priceText, 64)) return null;
  if (/^(?:aud|au\$|a\$)\s*\d/iu.test(priceText.trim())) {
    return "explicit-aud";
  }
  return /^\$\s*\d/u.test(priceText.trim()) ? "inferred-au-localisation" : null;
}

function boundedDetails(store) {
  if (!("details_and_offers" in store)) return [];
  if (
    !Array.isArray(store.details_and_offers) ||
    store.details_and_offers.length > 50
  ) {
    return null;
  }
  const details = store.details_and_offers.filter((entry) =>
    boundedProviderText(entry, 512),
  );
  return details.length === store.details_and_offers.length ? details : null;
}

function offerCondition(store, selectedCandidate, details) {
  if (selectedCandidate?.condition === "used") return "used";
  const explicit =
    conditionFromText(store.condition) === "unknown"
      ? conditionFromText(store.second_hand_condition)
      : conditionFromText(store.condition);
  if (explicit !== "unknown") return explicit;
  return conditionFromText(`${store.title} ${details.join(" ")}`);
}

function offerAvailability(store, details) {
  const combined = `${boundedProviderText(store.availability, 256) ? store.availability : ""} ${details.join(" ")}`;
  if (/\b(?:out of stock|sold out|unavailable)\b/iu.test(combined)) {
    return "out-of-stock";
  }
  return /\b(?:in stock|available online)\b/iu.test(combined)
    ? "in-stock"
    : "unknown";
}

function isFinancing(store) {
  return (
    (Number.isSafeInteger(store.monthly_payment_duration) &&
      store.monthly_payment_duration > 0 &&
      store.monthly_payment_duration <= 1_200) ||
    boundedProviderText(store.installments_description, 512) ||
    boundedProviderText(store.down_payment, 64)
  );
}

function normaliseOffer(store, selectedCandidate) {
  if (!store || typeof store !== "object" || Array.isArray(store)) return null;
  if (
    !boundedProviderText(store.name, 512) ||
    !boundedProviderText(store.title, 1_000)
  ) {
    return null;
  }
  const merchantUrl = directMerchantUrl(store.link);
  if (!merchantUrl) return null;
  const originalPriceText = boundedProviderText(store.price, 64)
    ? store.price
    : null;
  const basis = currencyBasis(originalPriceText);
  if (!basis) return null;
  const itemPriceCents = componentToCents(store.extracted_price, store.price);
  if (!validCents(itemPriceCents)) return null;
  const details = boundedDetails(store);
  if (!details) return null;

  const shippingCents = componentToCents(
    store.shipping_extracted,
    store.shipping,
    { allowFree: true },
  );
  const estimatedTaxCents = componentToCents(
    store.extracted_estimated_tax,
    store.estimated_tax,
  );
  const totalPriceCents = componentToCents(store.extracted_total, store.total);
  if (
    shippingCents === COMPONENT_CONFLICT ||
    estimatedTaxCents === COMPONENT_CONFLICT ||
    totalPriceCents === COMPONENT_CONFLICT
  ) {
    return null;
  }
  const condition = offerCondition(store, selectedCandidate, details);
  const availability = offerAvailability(store, details);
  const financing = isFinancing(store);
  const exclusionReasons = [];
  const packSize = packSizeFromTitle(store.title);

  let proposedComparison = null;
  let proposedBasis = "not_comparable";
  if (validCents(totalPriceCents)) {
    proposedComparison = totalPriceCents;
    proposedBasis = "provider_total";
  } else if (
    !financing &&
    validCents(shippingCents) &&
    (estimatedTaxCents === null || estimatedTaxCents === 0)
  ) {
    const delivered = itemPriceCents + shippingCents;
    if (validCents(delivered)) {
      proposedComparison = delivered;
      proposedBasis = "item_plus_shipping";
    }
  }

  if (financing && !validCents(totalPriceCents)) {
    exclusionReasons.push("financing_without_full_total");
  }
  if (condition === "used") exclusionReasons.push("used_or_second_hand");
  if (availability === "out-of-stock") exclusionReasons.push("out_of_stock");
  if (
    selectedCandidate !== undefined &&
    selectedCandidate !== null &&
    (selectedCandidate.packSize !== null || packSize !== null) &&
    packSize !== selectedCandidate.packSize
  ) {
    exclusionReasons.push("pack_mismatch");
  }
  if (!validCents(proposedComparison)) {
    exclusionReasons.push("unknown_comparison_total");
  }
  const comparisonEligible = exclusionReasons.length === 0;

  return {
    title: store.title,
    itemPriceCents,
    shippingCents: validCents(shippingCents) ? shippingCents : null,
    estimatedTaxCents: validCents(estimatedTaxCents) ? estimatedTaxCents : null,
    totalPriceCents: validCents(totalPriceCents) ? totalPriceCents : null,
    comparisonPriceCents: comparisonEligible ? proposedComparison : null,
    priceBasis: comparisonEligible ? proposedBasis : "not_comparable",
    originalPriceText,
    currencyBasis: basis,
    gstBasis: "unknown",
    packSize,
    condition,
    availability,
    financing,
    comparisonEligible,
    exclusionReasons,
    seller: store.name,
    sourceDomain: merchantUrl.hostname.toLowerCase(),
    url: merchantUrl.href,
  };
}

function canonicalOfferUrl(value) {
  const parsed = normaliseHttpsUrl(value);
  if (!parsed) return value;
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase();
    if (
      lower.startsWith("utm_") ||
      ["dclid", "fbclid", "gclid", "msclkid", "_ga"].includes(lower)
    ) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.sort();
  parsed.hash = "";
  return parsed.href;
}

function offerEvidencePriceBasis(offer) {
  if (validCents(offer.totalPriceCents)) return "provider_total";
  if (
    !offer.financing &&
    validCents(offer.shippingCents) &&
    (offer.estimatedTaxCents === null || offer.estimatedTaxCents === 0) &&
    validCents(offer.itemPriceCents + offer.shippingCents)
  ) {
    return "item_plus_shipping";
  }
  return "not_comparable";
}

function offerDedupeKey(offer) {
  return JSON.stringify([
    offer.sourceDomain,
    canonicalOfferUrl(offer.url),
    offer.title.trim().replace(/\s+/gu, " ").toLowerCase(),
    offer.packSize,
    offer.condition,
    offer.itemPriceCents,
    offer.shippingCents,
    offer.estimatedTaxCents,
    offer.totalPriceCents,
    offerEvidencePriceBasis(offer),
  ]);
}

function offersPayload(body, selectedCandidate, expectedToken) {
  const parameters = body.search_parameters;
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters) ||
    parameters.engine !== "google_immersive_product" ||
    parameters.page_token !== expectedToken
  ) {
    throw new ProviderRequestError(
      "immersive product response parameters are invalid",
    );
  }
  const product = body.product_results;
  if (!product || typeof product !== "object" || Array.isArray(product)) {
    throw new ProviderRequestError("immersive product result is invalid");
  }
  const stores = checkedArray(product, "stores");
  const nextPageToken = product.stores_next_page_token;
  if (
    nextPageToken !== undefined &&
    !boundedProviderText(nextPageToken, MAX_TOKEN_CHARACTERS)
  ) {
    throw new ProviderRequestError("stores continuation token is invalid");
  }
  const title = boundedProviderText(product.title, 1_000)
    ? product.title
    : selectedCandidate?.title;
  if (!boundedProviderText(title, 1_000)) {
    throw new ProviderRequestError("immersive product title is invalid");
  }
  const selectedProduct = {
    title,
    brand: boundedProviderText(product.brand, 256)
      ? product.brand
      : (selectedCandidate?.brand ?? null),
    productId: selectedCandidate?.productId ?? null,
  };

  const offers = [];
  const seen = new Map();
  for (const store of stores) {
    const offer = normaliseOffer(store, selectedCandidate);
    if (!offer) continue;
    const exactKey = offerDedupeKey(offer);
    const existingIndex = seen.get(exactKey);
    if (existingIndex === undefined) {
      seen.set(exactKey, offers.length);
      offers.push(offer);
    } else if (
      offers[existingIndex].comparisonEligible &&
      !offer.comparisonEligible
    ) {
      offers[existingIndex] = offer;
    }
  }
  return {
    stage: "offers",
    selectedProduct,
    offers,
    providerMeta: providerMeta(body, nextPageToken !== undefined),
  };
}

function validateResponseBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ProviderRequestError("provider response shape is invalid");
  }
  if (body.error) {
    if (/run out of searches|quota/iu.test(String(body.error))) {
      throw new ProviderQuotaError();
    }
    throw new ProviderRequestError("provider reported a request error");
  }
}

async function requestProvider(fetchImpl, params, signal) {
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
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new ProviderTimeoutError();
    }
    throw new ProviderRequestError("network request failed");
  }
  if (response.url) {
    const responseUrl = normaliseHttpsUrl(response.url);
    if (!responseUrl || responseUrl.hostname !== ALLOWED_PROVIDER_HOST) {
      throw new ProviderRequestError(
        "provider response escaped the host allowlist",
      );
    }
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ProviderRequestError("provider redirect rejected");
  }
  if (response.status === 429) throw new ProviderQuotaError();
  if (!response.ok) throw new ProviderRequestError(`HTTP ${response.status}`);
  const body = await readBoundedJson(response);
  validateResponseBody(body);
  return body;
}

export function createSerpApiProvider(env = process.env, fetchImpl = fetch) {
  const apiKey = env.SERPAPI_KEY ?? "";
  const location = normaliseAuLocation(env.SERPAPI_LOCATION);
  const rememberedCandidates = new Map();

  function rememberCandidates(providerQuery, candidates) {
    const issuedAt = Date.now();
    for (const [token, remembered] of rememberedCandidates) {
      if (
        issuedAt - remembered.issuedAt > REMEMBERED_CANDIDATE_TTL_MS ||
        remembered.providerQuery === providerQuery
      ) {
        rememberedCandidates.delete(token);
      }
    }
    for (const candidate of candidates) {
      rememberedCandidates.delete(candidate.token);
      rememberedCandidates.set(candidate.token, {
        providerQuery,
        candidate,
        issuedAt,
      });
      while (rememberedCandidates.size > MAX_REMEMBERED_CANDIDATES) {
        rememberedCandidates.delete(rememberedCandidates.keys().next().value);
      }
    }
  }

  function resolveCandidateSelection(
    providerQuery,
    { candidateToken, selectedCandidate } = {},
  ) {
    if (!boundedProviderText(providerQuery, 1_024)) {
      throw new ProviderRequestError("provider query is invalid");
    }
    if (!boundedProviderText(candidateToken, MAX_TOKEN_CHARACTERS)) {
      throw new ProviderRequestError("candidate token is invalid");
    }
    if (selectedCandidate !== undefined) {
      if (
        !selectedCandidate ||
        typeof selectedCandidate !== "object" ||
        Array.isArray(selectedCandidate) ||
        selectedCandidate.token !== candidateToken
      ) {
        throw new ProviderRequestError("selected candidate is invalid");
      }
      return selectedCandidate;
    }
    const remembered = rememberedCandidates.get(candidateToken);
    if (
      !remembered ||
      Date.now() - remembered.issuedAt > REMEMBERED_CANDIDATE_TTL_MS ||
      remembered.providerQuery !== providerQuery
    ) {
      rememberedCandidates.delete(candidateToken);
      throw new ProviderSelectionExpiredError();
    }
    return remembered.candidate;
  }

  return {
    name: "serpapi-google-shopping-au",
    requiresPaidCall: true,
    configured: apiKey !== "",
    capabilities: {
      id: "serpapi-google-shopping-au",
      displayName: "SerpAPI Google Shopping AU",
      mode: "two-stage-structured-offers",
      authentication: "API key",
      configured: apiKey !== "",
      quota: { kind: "provider-plan" },
      limits: { concurrency: 1, requestsPerMinute: 10 },
      cache: { ttlSeconds: 3_600, persistent: false },
      health: apiKey === "" ? "not-configured" : "unknown",
      lastSuccess: null,
      lastErrorCategory: null,
      dataRights:
        "Licensed intermediary terms and source-site rights remain the operator responsibility.",
      supportedIdentityFields: ["gtin", "mpn", "brand", "model", "title"],
    },
    resolveCandidateSelection,
    async search(
      providerQuery,
      { signal, candidateToken, selectedCandidate } = {},
    ) {
      if (apiKey === "") {
        throw new ProviderRequestError("SERPAPI_KEY is not configured");
      }
      if (location === null) {
        throw new ProviderRequestError(
          "SERPAPI_LOCATION must be a bounded city, state, Australia value",
        );
      }
      if (candidateToken !== undefined) {
        const trustedCandidate = resolveCandidateSelection(providerQuery, {
          candidateToken,
          selectedCandidate,
        });
        const params = new URLSearchParams({
          engine: "google_immersive_product",
          page_token: candidateToken,
          more_stores: "true",
          api_key: apiKey,
        });
        const body = await requestProvider(fetchImpl, params, signal);
        return offersPayload(body, trustedCandidate, candidateToken);
      }
      if (!boundedProviderText(providerQuery, 1_024)) {
        throw new ProviderRequestError("provider query is invalid");
      }
      const params = new URLSearchParams({
        engine: "google_shopping",
        q: providerQuery,
        google_domain: "google.com.au",
        gl: "au",
        hl: "en",
        device: "desktop",
        location,
        api_key: apiKey,
      });
      const body = await requestProvider(fetchImpl, params, signal);
      const payload = discoveryPayload(body, location, providerQuery);
      rememberCandidates(providerQuery, payload.candidates);
      return payload;
    },
  };
}
