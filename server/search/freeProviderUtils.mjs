import { TextDecoder } from 'node:util';
import { parseAmountToCents } from '../lib/moneyCents.mjs';
import { ProviderRequestError } from './providerErrors.mjs';

export const MAX_FREE_PROVIDER_RESPONSE_BYTES = 1_048_576;
const MAX_CENTS = 1_000_000_000;
const INTERMEDIARY_HOSTS = [
  'google.com',
  'google.com.au',
  'googleadservices.com',
  'serpapi.com',
  'serper.dev',
];

export function boundedProviderText(value, maximum, allowEmpty = false) {
  return (
    typeof value === 'string' &&
    value.length <= maximum &&
    (allowEmpty || value.length > 0) &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}

export function configuredSecret(value) {
  return (
    boundedProviderText(value, 2_048) && value.trim() === value && !/^replace_with_/u.test(value)
  );
}

export function amountToCents(value) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);
  } else if (boundedProviderText(value, 64)) {
    text = value.trim();
  } else {
    return null;
  }
  const cleaned = text
    .replace(/^(?:AUD|AU\$|A\$|\$)\s*/iu, '')
    .replace(/\s+AUD$/iu, '')
    .replace(/,/gu, '');
  const cents = parseAmountToCents(cleaned);
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_CENTS ? cents : null;
}

export function shippingTextToCents(value) {
  if (!boundedProviderText(value, 256)) return null;
  const text = value.trim();
  if (/\bfree\b/iu.test(text)) return 0;
  const match = /(?:AUD|AU\$|A\$|\$)\s*([\d,]+(?:\.\d{1,2})?)/iu.exec(text);
  return match ? amountToCents(match[1]) : null;
}

export function packSizeFromTitle(title) {
  const match =
    /\b(?:pack|box|carton|bag|set)\s+of\s+(\d{1,4})\b/iu.exec(title) ??
    /\b(\d{1,4})\s*(?:pack|pk)\b/iu.exec(title);
  return match ? `pack of ${match[1]}` : null;
}

function conditionFromText(value) {
  if (!boundedProviderText(value, 1_000, true)) return 'unknown';
  if (/\b(?:used|refurbished|pre[- ]owned|second[- ]hand)\b/iu.test(value)) {
    return 'used';
  }
  return /\bnew\b/iu.test(value) ? 'new' : 'unknown';
}

function availabilityFromText(value) {
  if (!boundedProviderText(value, 512, true)) return 'unknown';
  if (/\b(?:out of stock|unavailable|sold out)\b/iu.test(value)) {
    return 'out-of-stock';
  }
  return /\b(?:in stock|available|buy it now)\b/iu.test(value) ? 'in-stock' : 'unknown';
}

export function merchantUrl(value) {
  if (!boundedProviderText(value, 2_048)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname === '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    INTERMEDIARY_HOSTS.some(
      (intermediary) => host === intermediary || host.endsWith(`.${intermediary}`),
    )
  ) {
    return null;
  }
  parsed.hostname = host;
  parsed.hash = '';
  return parsed;
}

export function createStructuredOffer({
  title,
  seller,
  url,
  itemPriceCents,
  shippingCents,
  originalPriceText,
  currencyBasis,
  conditionText = '',
  availabilityText = '',
  financing = false,
}) {
  if (
    !boundedProviderText(title, 1_000) ||
    !boundedProviderText(seller, 512) ||
    !Number.isSafeInteger(itemPriceCents) ||
    itemPriceCents < 0 ||
    itemPriceCents > MAX_CENTS ||
    (shippingCents !== null &&
      (!Number.isSafeInteger(shippingCents) || shippingCents < 0 || shippingCents > MAX_CENTS)) ||
    !boundedProviderText(originalPriceText, 64) ||
    !['explicit-aud', 'inferred-au-localisation'].includes(currencyBasis)
  ) {
    return null;
  }
  const sourceUrl = merchantUrl(url);
  if (!sourceUrl) return null;
  const condition = conditionFromText(`${conditionText} ${title}`);
  const availability = availabilityFromText(availabilityText);
  const exclusionReasons = [];
  if (shippingCents === null) {
    exclusionReasons.push('delivered-total-unavailable');
  }
  if (condition === 'used') exclusionReasons.push('used-or-refurbished');
  if (availability === 'out-of-stock') exclusionReasons.push('out-of-stock');
  if (financing) exclusionReasons.push('financing-price');
  const totalPriceCents =
    shippingCents === null || itemPriceCents + shippingCents > MAX_CENTS
      ? null
      : itemPriceCents + shippingCents;
  if (shippingCents !== null && totalPriceCents === null) {
    exclusionReasons.push('delivered-total-outside-range');
  }
  const comparisonEligible = exclusionReasons.length === 0 && totalPriceCents !== null;
  return {
    title,
    itemPriceCents,
    shippingCents,
    estimatedTaxCents: null,
    totalPriceCents,
    comparisonPriceCents: comparisonEligible ? totalPriceCents : null,
    priceBasis: comparisonEligible ? 'item_plus_shipping' : 'not_comparable',
    originalPriceText,
    currencyBasis,
    gstBasis: 'unknown',
    packSize: packSizeFromTitle(title),
    condition,
    availability,
    financing,
    comparisonEligible,
    exclusionReasons,
    seller,
    sourceDomain: sourceUrl.hostname,
    url: sourceUrl.href,
  };
}

export async function readBoundedProviderJson(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new ProviderRequestError('response content type is not JSON');
  }
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_FREE_PROVIDER_RESPONSE_BYTES)
  ) {
    throw new ProviderRequestError('response size is outside the supported range');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new ProviderRequestError('response body is unavailable');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_FREE_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProviderRequestError('response size is outside the supported range');
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ProviderRequestError('response JSON is invalid');
  }
}

export function displayProviderQuery(providerQuery) {
  if (!boundedProviderText(providerQuery, 1_024)) return null;
  return providerQuery.startsWith('"') && providerQuery.endsWith('"')
    ? providerQuery.slice(1, -1)
    : providerQuery;
}
