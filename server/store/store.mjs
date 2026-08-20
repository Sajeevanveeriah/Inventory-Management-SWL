import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  amountExGstCents,
  centsToAmount,
  deriveSellPriceCents,
  minimumSellPriceCents,
} from '../lib/moneyCents.mjs';

/**
 * File-backed persistence for the small Node service. Chosen deliberately:
 * the deployment shape is one SPA plus one small server on one machine, so a
 * JSON/JSONL directory store is the smallest fit. History files are JSONL and
 * APPEND-ONLY: this module exposes no update or delete for them.
 *
 * Persisted: catalogue items, price history (append-only versions), approval
 * records (who and when), competitor reference prices, source registry state.
 * Secrets are never persisted here; keys live only in the environment.
 */

export class FloorViolationError extends Error {
  constructor() {
    super('The proposed sell price is below the required 30 percent markup floor. Refused.');
    this.name = 'FloorViolationError';
  }
}
export class MissingApprovalError extends Error {
  constructor() {
    super('A published price version requires an existing approval record. Refused.');
    this.name = 'MissingApprovalError';
  }
}
export class MissingCatalogueItemError extends Error {
  constructor() {
    super('The catalogue item does not exist. Reference refused.');
    this.name = 'MissingCatalogueItemError';
  }
}

export class PublicationValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicationValidationError';
  }
}

const MAX_BATCH_RECORDS = 10_000;
const MAX_SOURCE_RECORDS = 1_000;
const MAX_APPROVAL_RECORDS = 500_000;
const MAX_HISTORY_RECORDS = 1_000_000;
const MAX_REFERENCE_RECORDS = 1_000_000;
const MAX_CENTS = 1_000_000_000;
const SOURCE_ACCESS_METHODS = new Set(['live-api', 'manual-entry', 'file-import']);
const GST_BASES = new Set(['inc-gst', 'ex-gst', 'unknown']);
const RESOLVED_GST_BASES = new Set(['inc-gst', 'ex-gst']);
const ITEM_KINDS = new Set(['physical-product', 'service', 'labour']);
const MARKUP_SOURCES = new Set(['product', 'brand', 'global']);

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function assertText(value, name, max, allowEmpty = false) {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > max ||
    containsControlCharacter(value)
  ) {
    throw new PublicationValidationError(`${name} is invalid.`);
  }
}

function assertIdentifier(value, name, max = 128) {
  assertText(value, name, max);
  if (value.trim() !== value) {
    throw new PublicationValidationError(`${name} is invalid.`);
  }
}

function assertCents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) {
    throw new PublicationValidationError(`${name} is outside the supported range.`);
  }
}

function nullableText(value, name, max, identifier = false) {
  if (value === null || value === undefined) return null;
  if (identifier) assertIdentifier(value, name, max);
  else assertText(value, name, max, true);
  return value;
}

function parseMarkupHundredths(value, name = 'Markup') {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,2})?$/u.test(value)) {
    throw new PublicationValidationError(`${name} is invalid.`);
  }
  const [whole, fraction = ''] = value.split('.');
  const hundredths = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
  if (hundredths > 99_999) {
    throw new PublicationValidationError(`${name} is outside the supported range.`);
  }
  return hundredths;
}

function validateCatalogueItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new PublicationValidationError('Catalogue item is invalid.');
  }
  assertAllowedKeys(
    item,
    ['costCents', 'description', 'id', 'sellPriceCents'],
    [
      'barcodeGtin',
      'brandId',
      'gstBasis',
      'itemKind',
      'itemNumber',
      'markupOverridePercent',
      'selectedOfferId',
      'sellPriceGstBasis',
      'servicem8Reference',
      'sku',
      'updatedAt',
      'xeroReference',
    ],
    'Catalogue item',
  );
  assertIdentifier(item.id, 'Catalogue identifier');
  const itemNumber = item.itemNumber ?? item.sku;
  assertIdentifier(itemNumber, 'Item number');
  if (
    Object.hasOwn(item, 'itemNumber') &&
    Object.hasOwn(item, 'sku') &&
    item.itemNumber !== item.sku
  ) {
    throw new PublicationValidationError('Catalogue item identifiers disagree.');
  }
  assertText(item.description, 'Description', 2_000, true);
  assertCents(item.costCents, 'Cost');
  assertCents(item.sellPriceCents, 'Sell price');
  const gstBasis = item.gstBasis ?? 'unknown';
  if (!GST_BASES.has(gstBasis)) {
    throw new PublicationValidationError('GST basis is invalid.');
  }
  const sellPriceGstBasis = item.sellPriceGstBasis ?? gstBasis;
  if (!GST_BASES.has(sellPriceGstBasis)) {
    throw new PublicationValidationError('Sell-price GST basis is invalid.');
  }
  const itemKind = item.itemKind ?? 'physical-product';
  if (!ITEM_KINDS.has(itemKind)) {
    throw new PublicationValidationError('Catalogue item kind is invalid.');
  }
  const brandId = nullableText(item.brandId, 'Brand identifier', 128, true);
  const selectedOfferId = nullableText(
    item.selectedOfferId,
    'Selected supplier-offer identifier',
    128,
    true,
  );
  const markupOverridePercent = item.markupOverridePercent ?? null;
  if (markupOverridePercent !== null) {
    parseMarkupHundredths(markupOverridePercent, 'Product markup');
  }
  const xeroReference = nullableText(item.xeroReference, 'Xero reference', 256);
  const servicem8Reference = nullableText(item.servicem8Reference, 'ServiceM8 reference', 256);
  const barcodeGtin = nullableText(item.barcodeGtin, 'Barcode or GTIN', 128);
  if (Object.hasOwn(item, 'updatedAt')) {
    assertTimestamp(item.updatedAt, 'Catalogue update time');
  }
  return {
    id: item.id,
    itemNumber,
    description: item.description,
    itemKind,
    brandId,
    markupOverridePercent,
    xeroReference,
    servicem8Reference,
    barcodeGtin,
    selectedOfferId,
    costCents: item.costCents,
    sellPriceCents: item.sellPriceCents,
    gstBasis,
    sellPriceGstBasis,
    ...(Object.hasOwn(item, 'updatedAt') ? { updatedAt: item.updatedAt } : {}),
  };
}

function validatePublishedCatalogueItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new PublicationValidationError('Catalogue item is invalid.');
  }
  assertExactKeys(
    item,
    [
      'barcodeGtin',
      'brandId',
      'costCents',
      'description',
      'gstBasis',
      'id',
      'itemKind',
      'itemNumber',
      'markupOverridePercent',
      'selectedOfferId',
      'sellPriceCents',
      'sellPriceGstBasis',
      'servicem8Reference',
      'updatedAt',
      'xeroReference',
    ],
    'Approved catalogue item',
  );
  const canonical = validateCatalogueItem(item);
  if (
    canonical.selectedOfferId === null ||
    !RESOLVED_GST_BASES.has(canonical.gstBasis) ||
    !RESOLVED_GST_BASES.has(canonical.sellPriceGstBasis)
  ) {
    throw new PublicationValidationError(
      'Approved publication requires a selected supplier offer and confirmed GST bases.',
    );
  }
  return canonical;
}

function validatePricingProvenance(provenance, item) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new PublicationValidationError('Resolved pricing provenance is required.');
  }
  assertExactKeys(
    provenance,
    [
      'brandId',
      'costGstBasis',
      'currency',
      'explanation',
      'itemKind',
      'markupPercent',
      'markupSource',
      'markupSourceId',
      'ruleVersion',
      'selectedOfferId',
      'sellPriceGstBasis',
      'supplierId',
      'supplierName',
      'supplierSku',
    ],
    'Resolved pricing provenance',
  );
  assertIdentifier(provenance.selectedOfferId, 'Selected supplier-offer identifier');
  assertIdentifier(provenance.supplierId, 'Supplier identifier');
  assertText(provenance.supplierName, 'Supplier name', 256);
  assertText(provenance.supplierSku, 'Supplier SKU', 256);
  assertText(provenance.explanation, 'Pricing explanation', 2_000);
  if (!RESOLVED_GST_BASES.has(provenance.costGstBasis)) {
    throw new PublicationValidationError('Cost GST basis is invalid.');
  }
  if (!RESOLVED_GST_BASES.has(provenance.sellPriceGstBasis)) {
    throw new PublicationValidationError('Sell-price GST basis is invalid.');
  }
  if (provenance.currency !== 'AUD') {
    throw new PublicationValidationError('Pricing currency must be AUD.');
  }
  if (!MARKUP_SOURCES.has(provenance.markupSource)) {
    throw new PublicationValidationError('Markup source is invalid.');
  }
  if (!ITEM_KINDS.has(provenance.itemKind)) {
    throw new PublicationValidationError('Pricing item kind is invalid.');
  }
  const brandId = nullableText(provenance.brandId, 'Pricing brand identifier', 128, true);
  const markupSourceId = nullableText(
    provenance.markupSourceId,
    'Markup-source identifier',
    128,
    true,
  );
  const markupHundredths = parseMarkupHundredths(provenance.markupPercent);
  if (provenance.ruleVersion !== 'pricing-rule-v1') {
    throw new PublicationValidationError('Pricing rule version is invalid.');
  }
  if (
    provenance.selectedOfferId !== item.selectedOfferId ||
    provenance.costGstBasis !== item.gstBasis ||
    provenance.sellPriceGstBasis !== item.sellPriceGstBasis ||
    provenance.itemKind !== item.itemKind ||
    brandId !== item.brandId
  ) {
    throw new PublicationValidationError(
      'The approved item and resolved pricing provenance disagree.',
    );
  }
  if (item.markupOverridePercent !== null) {
    if (
      provenance.markupSource !== 'product' ||
      markupSourceId !== item.id ||
      markupHundredths !== parseMarkupHundredths(item.markupOverridePercent, 'Product markup')
    ) {
      throw new PublicationValidationError('The resolved product markup identity is invalid.');
    }
  } else if (provenance.markupSource === 'product') {
    throw new PublicationValidationError('A product markup source requires a product override.');
  }
  if (
    provenance.markupSource === 'brand' &&
    (item.brandId === null || markupSourceId !== item.brandId)
  ) {
    throw new PublicationValidationError('The resolved brand markup identity is invalid.');
  }
  if (provenance.markupSource === 'global' && markupSourceId !== null) {
    throw new PublicationValidationError('The global markup source must not name another record.');
  }
  const expectedSellPriceCents = deriveSellPriceCents(
    item.costCents,
    provenance.costGstBasis,
    markupHundredths,
    provenance.sellPriceGstBasis,
  );
  if (item.sellPriceCents !== expectedSellPriceCents) {
    throw new PublicationValidationError(
      'The proposed sell price does not match the resolved markup rule.',
    );
  }
  const costExGstCents = amountExGstCents(item.costCents, provenance.costGstBasis);
  const sellExGstCents = amountExGstCents(item.sellPriceCents, provenance.sellPriceGstBasis);
  const floor = minimumSellPriceCents(costExGstCents);
  if (sellExGstCents < floor) {
    throw new FloorViolationError(item.sellPriceCents, floor);
  }
  return {
    selectedOfferId: provenance.selectedOfferId,
    supplierId: provenance.supplierId,
    supplierName: provenance.supplierName,
    supplierSku: provenance.supplierSku,
    costGstBasis: provenance.costGstBasis,
    sellPriceGstBasis: provenance.sellPriceGstBasis,
    currency: 'AUD',
    markupPercent: provenance.markupPercent,
    markupHundredths,
    markupSource: provenance.markupSource,
    markupSourceId,
    brandId,
    itemKind: provenance.itemKind,
    ruleVersion: 'pricing-rule-v1',
    costExGstCents,
    explanation: `Selected supplier offer ${provenance.selectedOfferId} from ${provenance.supplierName}; applied the resolved ${provenance.markupSource} markup of ${provenance.markupPercent}% to AUD ${centsToAmount(costExGstCents)} ex GST; verified exact sell price AUD ${centsToAmount(item.sellPriceCents)} and the 30% minimum floor.`,
  };
}

function validateSourceRegistry(sources) {
  if (!Array.isArray(sources) || sources.length > MAX_SOURCE_RECORDS) {
    throw new PublicationValidationError(
      'The source registry size is outside the supported range.',
    );
  }
  const identifiers = new Set();
  return sources.map((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new PublicationValidationError('Source registry entry is invalid.');
    }
    const expectedKeys = ['accessMethod', 'automatedAccessNote', 'enabled', 'id', 'name'];
    const actualKeys = Object.keys(source).sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      throw new PublicationValidationError('Source registry entry has unsupported fields.');
    }
    assertIdentifier(source.id, 'Source identifier');
    assertText(source.name, 'Source name', 256);
    assertText(source.automatedAccessNote, 'Automated access note', 2_000, true);
    if (!SOURCE_ACCESS_METHODS.has(source.accessMethod)) {
      throw new PublicationValidationError('Source access method is invalid.');
    }
    if (typeof source.enabled !== 'boolean') {
      throw new PublicationValidationError('Source enabled state is invalid.');
    }
    if (identifiers.has(source.id)) {
      throw new PublicationValidationError('Source identifiers must be unique.');
    }
    identifiers.add(source.id);
    return {
      id: source.id,
      name: source.name,
      accessMethod: source.accessMethod,
      automatedAccessNote: source.automatedAccessNote,
      enabled: source.enabled,
    };
  });
}

function assertExactKeys(value, expectedKeys, name) {
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    throw new PublicationValidationError(`${name} has unsupported fields.`);
  }
}

function assertAllowedKeys(value, requiredKeys, optionalKeys, name) {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    requiredKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new PublicationValidationError(`${name} has unsupported fields.`);
  }
}

function assertTimestamp(value, name) {
  assertText(value, name, 64);
  const shape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value);
  const parsed = new Date(value);
  const canonical = value.length === 20 ? value.replace(/Z$/u, '.000Z') : value;
  if (!shape || Number.isNaN(parsed.getTime()) || parsed.toISOString() !== canonical) {
    throw new PublicationValidationError(`${name} is invalid.`);
  }
}

function assertEvidenceMoney(value, name, requireTwoDecimals) {
  assertText(value, name, 32);
  const match = /^(\d+)\.(\d{1,2})$/u.exec(value);
  if (!match || (requireTwoDecimals && match[2].length !== 2)) {
    throw new PublicationValidationError(`${name} is invalid.`);
  }
  const cents = BigInt(match[1]) * 100n + BigInt(match[2].padEnd(2, '0'));
  if (cents > BigInt(MAX_CENTS)) {
    throw new PublicationValidationError(`${name} is outside the supported range.`);
  }
  return Number(cents);
}

function validateHttpsUrl(value, name) {
  assertText(value, name, 2_048);
  let sourceUrl;
  try {
    sourceUrl = new URL(value);
  } catch {
    throw new PublicationValidationError(`${name} is invalid.`);
  }
  if (
    sourceUrl.protocol !== 'https:' ||
    sourceUrl.hostname === '' ||
    sourceUrl.username !== '' ||
    sourceUrl.password !== ''
  ) {
    throw new PublicationValidationError(`${name} is outside the safe HTTPS boundary.`);
  }
  return sourceUrl;
}

function validateMoneyPair(centsValue, amountValue, name, nullable = false) {
  if (nullable && centsValue === null && amountValue === null) return null;
  if (nullable && (centsValue === null || amountValue === null)) {
    throw new PublicationValidationError(`${name} representations disagree.`);
  }
  assertCents(centsValue, name);
  if (assertEvidenceMoney(amountValue, name, true) !== centsValue) {
    throw new PublicationValidationError(`${name} representations disagree.`);
  }
  return centsValue;
}

function validateStructuredLiveReferenceObservation(observation) {
  const requiredKeys = [
    'availability',
    'comparisonEligible',
    'comparisonPriceAud',
    'comparisonPriceCents',
    'condition',
    'currency',
    'currencyBasis',
    'estimatedTaxAud',
    'estimatedTaxCents',
    'exclusionReasons',
    'financing',
    'gstBasis',
    'itemPriceAud',
    'itemPriceCents',
    'originalPriceText',
    'packSize',
    'priceAud',
    'priceBasis',
    'priceCents',
    'retrievedAt',
    'seller',
    'shippingAud',
    'shippingCents',
    'sourceDomain',
    'title',
    'totalPriceAud',
    'totalPriceCents',
    'url',
  ];
  const provenanceKeys = [
    'searchQuery',
    'selectedProductTitle',
    'selectedProductBrand',
    'selectedProductId',
  ];
  assertAllowedKeys(observation, requiredKeys, provenanceKeys, 'Competitor observation');
  const presentProvenance = provenanceKeys.filter((key) => Object.hasOwn(observation, key));
  if (presentProvenance.length !== 0 && presentProvenance.length !== provenanceKeys.length) {
    throw new PublicationValidationError('Observation selected-product provenance is incomplete.');
  }
  if (presentProvenance.length === provenanceKeys.length) {
    assertText(observation.searchQuery, 'Observation search query', 512);
    assertText(observation.selectedProductTitle, 'Observation selected product title', 1_000);
    for (const [field, label, limit] of [
      ['selectedProductBrand', 'Observation selected product brand', 512],
      ['selectedProductId', 'Observation selected product identifier', 512],
    ]) {
      if (observation[field] !== null) {
        assertText(observation[field], label, limit);
      }
    }
  }
  assertText(observation.title, 'Observation title', 1_000);
  validateMoneyPair(observation.itemPriceCents, observation.itemPriceAud, 'Observation item price');
  validateMoneyPair(observation.priceCents, observation.priceAud, 'Observation price');
  if (
    observation.priceCents !== observation.itemPriceCents ||
    observation.priceAud !== observation.itemPriceAud
  ) {
    throw new PublicationValidationError('Observation item-price aliases disagree.');
  }
  validateMoneyPair(
    observation.shippingCents,
    observation.shippingAud,
    'Observation shipping',
    true,
  );
  validateMoneyPair(
    observation.estimatedTaxCents,
    observation.estimatedTaxAud,
    'Observation estimated tax',
    true,
  );
  validateMoneyPair(
    observation.totalPriceCents,
    observation.totalPriceAud,
    'Observation provider total',
    true,
  );
  validateMoneyPair(
    observation.comparisonPriceCents,
    observation.comparisonPriceAud,
    'Observation comparison total',
    true,
  );
  if (observation.currency !== 'AUD') {
    throw new PublicationValidationError('Observation currency is invalid.');
  }
  if (!['explicit-aud', 'inferred-au-localisation'].includes(observation.currencyBasis)) {
    throw new PublicationValidationError('Observation currency basis is invalid.');
  }
  if (!['inc-gst', 'ex-gst', 'unknown'].includes(observation.gstBasis)) {
    throw new PublicationValidationError('Observation GST basis is invalid.');
  }
  if (observation.packSize !== null) {
    assertText(observation.packSize, 'Observation pack size', 256, true);
  }
  if (!['new', 'used', 'unknown'].includes(observation.condition)) {
    throw new PublicationValidationError('Observation condition is invalid.');
  }
  if (!['in-stock', 'out-of-stock', 'unknown'].includes(observation.availability)) {
    throw new PublicationValidationError('Observation availability is invalid.');
  }
  if (
    typeof observation.financing !== 'boolean' ||
    typeof observation.comparisonEligible !== 'boolean'
  ) {
    throw new PublicationValidationError('Observation comparison flags are invalid.');
  }
  if (
    !Array.isArray(observation.exclusionReasons) ||
    observation.exclusionReasons.length > 20 ||
    observation.exclusionReasons.some((reason) => {
      try {
        assertText(reason, 'Observation exclusion reason', 128);
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new PublicationValidationError('Observation exclusion reasons are invalid.');
  }
  if (
    !['provider_total', 'item_plus_shipping', 'not_comparable'].includes(observation.priceBasis)
  ) {
    throw new PublicationValidationError('Observation comparison basis is invalid.');
  }
  if (observation.comparisonEligible) {
    if (
      observation.exclusionReasons.length !== 0 ||
      observation.comparisonPriceCents === null ||
      observation.priceBasis === 'not_comparable' ||
      (observation.priceBasis === 'provider_total' &&
        observation.comparisonPriceCents !== observation.totalPriceCents) ||
      (observation.priceBasis === 'item_plus_shipping' &&
        (observation.shippingCents === null ||
          observation.comparisonPriceCents !==
            observation.itemPriceCents + observation.shippingCents ||
          (observation.estimatedTaxCents !== null && observation.estimatedTaxCents !== 0))) ||
      observation.condition === 'used' ||
      observation.availability === 'out-of-stock'
    ) {
      throw new PublicationValidationError('Observation comparison eligibility is invalid.');
    }
  } else if (
    observation.exclusionReasons.length === 0 ||
    observation.comparisonPriceCents !== null ||
    observation.priceBasis !== 'not_comparable'
  ) {
    throw new PublicationValidationError('Observation comparison exclusion is invalid.');
  }
  assertText(observation.originalPriceText, 'Observation original price', 64);
  assertText(observation.seller, 'Observation seller', 512);
  assertText(observation.sourceDomain, 'Observation source domain', 253);
  const sourceUrl = validateHttpsUrl(observation.url, 'Observation URL');
  if (sourceUrl.hostname.toLowerCase() !== observation.sourceDomain.toLowerCase()) {
    throw new PublicationValidationError('Observation URL is outside the safe HTTPS boundary.');
  }
  assertTimestamp(observation.retrievedAt, 'Observation retrieval time');
  return { ...observation, url: sourceUrl.href };
}

function validateLiveReferenceObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new PublicationValidationError('The competitor observation is invalid.');
  }
  if (Object.hasOwn(observation, 'itemPriceCents')) {
    return validateStructuredLiveReferenceObservation(observation);
  }
  assertExactKeys(
    observation,
    [
      'currency',
      'gstBasis',
      'packSize',
      'priceAud',
      'priceCents',
      'retrievedAt',
      'seller',
      'sourceDomain',
      'title',
      'url',
    ],
    'Competitor observation',
  );
  assertText(observation.title, 'Observation title', 1_000);
  assertCents(observation.priceCents, 'Observation price');
  if (
    assertEvidenceMoney(observation.priceAud, 'Observation price', true) !== observation.priceCents
  ) {
    throw new PublicationValidationError('Observation price representations disagree.');
  }
  if (observation.currency !== 'AUD') {
    throw new PublicationValidationError('Observation currency is invalid.');
  }
  if (!['inc-gst', 'ex-gst', 'unknown'].includes(observation.gstBasis)) {
    throw new PublicationValidationError('Observation GST basis is invalid.');
  }
  if (observation.packSize !== null) {
    assertText(observation.packSize, 'Observation pack size', 256, true);
  }
  assertText(observation.seller, 'Observation seller', 512);
  assertText(observation.sourceDomain, 'Observation source domain', 253);
  const sourceUrl = validateHttpsUrl(observation.url, 'Observation URL');
  if (sourceUrl.hostname.toLowerCase() !== observation.sourceDomain.toLowerCase()) {
    throw new PublicationValidationError('Observation URL is outside the safe HTTPS boundary.');
  }
  assertTimestamp(observation.retrievedAt, 'Observation retrieval time');
  return {
    title: observation.title,
    priceCents: observation.priceCents,
    priceAud: observation.priceAud,
    currency: observation.currency,
    gstBasis: observation.gstBasis,
    packSize: observation.packSize,
    seller: observation.seller,
    sourceDomain: observation.sourceDomain,
    url: sourceUrl.href,
    retrievedAt: observation.retrievedAt,
  };
}

function validateManualReferenceObservation(observation) {
  const requiredKeys = [
    'approvedSource',
    'condition',
    'currency',
    'gstBasis',
    'matchConfidence',
    'observedAt',
    'packCompatible',
    'price',
    'productOnly',
    'reviewState',
    'shipping',
    'sku',
    'sourceName',
    'stockStatus',
  ];
  assertAllowedKeys(
    observation,
    requiredKeys,
    ['ambiguousMatch', 'packSize', 'url'],
    'Competitor observation',
  );
  assertIdentifier(observation.sku, 'Observation SKU');
  assertText(observation.sourceName, 'Observation source name', 256);
  assertTimestamp(observation.observedAt, 'Observation time');
  assertEvidenceMoney(observation.price, 'Observation price', false);
  assertEvidenceMoney(observation.shipping, 'Observation shipping', false);
  if (observation.currency !== 'AUD') {
    throw new PublicationValidationError('Observation currency is invalid.');
  }
  if (!['inc-gst', 'ex-gst', 'unknown'].includes(observation.gstBasis)) {
    throw new PublicationValidationError('Observation GST basis is invalid.');
  }
  if (!['in-stock', 'out-of-stock', 'unknown'].includes(observation.stockStatus)) {
    throw new PublicationValidationError('Observation stock status is invalid.');
  }
  if (!['new', 'used', 'unknown'].includes(observation.condition)) {
    throw new PublicationValidationError('Observation condition is invalid.');
  }
  if (!['accepted', 'rejected', 'quarantined'].includes(observation.reviewState)) {
    throw new PublicationValidationError('Observation review state is invalid.');
  }
  for (const field of ['approvedSource', 'packCompatible', 'productOnly']) {
    if (typeof observation[field] !== 'boolean') {
      throw new PublicationValidationError(`Observation ${field} state is invalid.`);
    }
  }
  if (
    !Number.isFinite(observation.matchConfidence) ||
    observation.matchConfidence < 0 ||
    observation.matchConfidence > 1
  ) {
    throw new PublicationValidationError('Observation match confidence is invalid.');
  }
  if (
    Object.hasOwn(observation, 'ambiguousMatch') &&
    typeof observation.ambiguousMatch !== 'boolean'
  ) {
    throw new PublicationValidationError('Observation ambiguity state is invalid.');
  }
  if (Object.hasOwn(observation, 'url')) {
    validateHttpsUrl(observation.url, 'Observation URL');
  }
  if (Object.hasOwn(observation, 'packSize')) {
    assertText(observation.packSize, 'Observation pack size', 256, true);
  }
  return Object.fromEntries(
    [...requiredKeys, 'ambiguousMatch', 'url', 'packSize']
      .filter((key) => Object.hasOwn(observation, key))
      .map((key) => [key, observation[key]]),
  );
}

function validateReferenceObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new PublicationValidationError('The competitor observation is invalid.');
  }
  return Object.hasOwn(observation, 'title') || Object.hasOwn(observation, 'priceCents')
    ? validateLiveReferenceObservation(observation)
    : validateManualReferenceObservation(observation);
}

function validateCatalogueCollection(items) {
  if (!Array.isArray(items) || items.length > MAX_BATCH_RECORDS) {
    throw new PublicationValidationError('Stored catalogue size is outside the supported range.');
  }
  const itemIds = new Set();
  const itemNumbers = new Set();
  return items.map((item) => {
    const canonical = validateCatalogueItem(item);
    if (itemIds.has(canonical.id) || itemNumbers.has(canonical.itemNumber)) {
      throw new PublicationValidationError('Stored catalogue identifiers must be unique.');
    }
    itemIds.add(canonical.id);
    itemNumbers.add(canonical.itemNumber);
    return canonical;
  });
}

function validateApprovalCollection(records, itemIds) {
  if (!Array.isArray(records) || records.length > MAX_APPROVAL_RECORDS) {
    throw new PublicationValidationError('Stored approval count is outside the supported range.');
  }
  const identifiers = new Set();
  return records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new PublicationValidationError('Stored approval is invalid.');
    }
    assertExactKeys(
      record,
      ['approvedAt', 'approvedBy', 'id', 'itemId', 'proposedSellCents', 'reason'],
      'Stored approval',
    );
    assertIdentifier(record.id, 'Approval identifier');
    assertIdentifier(record.itemId, 'Catalogue identifier');
    assertText(record.approvedBy, 'Approver', 128);
    assertCents(record.proposedSellCents, 'Proposed sell price');
    assertText(record.reason, 'Approval reason', 1_000, true);
    assertTimestamp(record.approvedAt, 'Approval time');
    if (identifiers.has(record.id)) {
      throw new PublicationValidationError('Stored approval identifiers must be unique.');
    }
    if (!itemIds.has(record.itemId)) {
      throw new PublicationValidationError('Stored approval references a missing catalogue item.');
    }
    identifiers.add(record.id);
    return {
      id: record.id,
      itemId: record.itemId,
      approvedBy: record.approvedBy,
      proposedSellCents: record.proposedSellCents,
      reason: record.reason,
      approvedAt: record.approvedAt,
    };
  });
}

function validatePriceHistoryCollection(records, itemIds, approvals) {
  if (!Array.isArray(records) || records.length > MAX_HISTORY_RECORDS) {
    throw new PublicationValidationError(
      'Stored price-history count is outside the supported range.',
    );
  }
  const identifiers = new Set();
  const approvalById = new Map(approvals.map((approval) => [approval.id, approval]));
  return records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new PublicationValidationError('Stored price history is invalid.');
    }
    const isLegacyShape = !Object.hasOwn(record, 'provenanceState');
    if (isLegacyShape) {
      assertExactKeys(
        record,
        [
          'approvalId',
          'cost',
          'costCents',
          'id',
          'itemId',
          'recordedAt',
          'sellPrice',
          'sellPriceCents',
        ],
        'Stored price history',
      );
    } else {
      assertExactKeys(
        record,
        [
          'appliedMarkupHundredths',
          'approvalId',
          'brandId',
          'cost',
          'costBasisCents',
          'costCents',
          'costGstBasis',
          'currency',
          'id',
          'itemId',
          'itemKind',
          'markupSourceId',
          'markupSourceType',
          'pricingExplanation',
          'provenanceState',
          'recordedAt',
          'ruleVersion',
          'selectedOfferId',
          'sellPrice',
          'sellPriceCents',
          'sellPriceGstBasis',
          'supplierId',
          'supplierName',
          'supplierSku',
        ],
        'Stored price history',
      );
    }
    assertIdentifier(record.id, 'Price-history identifier');
    assertIdentifier(record.itemId, 'Catalogue identifier');
    assertIdentifier(record.approvalId, 'Approval identifier');
    assertCents(record.costCents, 'Cost');
    assertCents(record.sellPriceCents, 'Sell price');
    assertTimestamp(record.recordedAt, 'Price-history time');
    if (
      record.cost !== centsToAmount(record.costCents) ||
      record.sellPrice !== centsToAmount(record.sellPriceCents)
    ) {
      throw new PublicationValidationError('Stored price representations disagree.');
    }
    if (identifiers.has(record.id)) {
      throw new PublicationValidationError('Stored price-history identifiers must be unique.');
    }
    if (!itemIds.has(record.itemId)) {
      throw new PublicationValidationError(
        'Stored price history references a missing catalogue item.',
      );
    }
    const approval = approvalById.get(record.approvalId);
    if (
      !approval ||
      approval.itemId !== record.itemId ||
      approval.proposedSellCents !== record.sellPriceCents
    ) {
      throw new PublicationValidationError(
        'Stored price history references an incompatible approval.',
      );
    }
    identifiers.add(record.id);
    const common = {
      id: record.id,
      itemId: record.itemId,
      costCents: record.costCents,
      sellPriceCents: record.sellPriceCents,
      cost: record.cost,
      sellPrice: record.sellPrice,
      approvalId: record.approvalId,
      recordedAt: record.recordedAt,
    };
    if (isLegacyShape) {
      if (record.sellPriceCents < minimumSellPriceCents(record.costCents)) {
        throw new PublicationValidationError(
          'Stored price history violates the required markup floor.',
        );
      }
      return {
        ...common,
        selectedOfferId: null,
        supplierId: null,
        supplierName: null,
        supplierSku: null,
        costGstBasis: null,
        sellPriceGstBasis: 'unknown',
        currency: null,
        costBasisCents: record.costCents,
        markupSourceType: 'legacy-global',
        markupSourceId: null,
        appliedMarkupHundredths: null,
        brandId: null,
        itemKind: null,
        pricingExplanation: null,
        ruleVersion: 'legacy-unresolved',
        provenanceState: 'legacy-unresolved',
      };
    }
    if (record.provenanceState === 'legacy-unresolved') {
      if (
        record.selectedOfferId !== null ||
        record.supplierId !== null ||
        record.supplierName !== null ||
        record.supplierSku !== null ||
        record.costGstBasis !== null ||
        record.sellPriceGstBasis !== 'unknown' ||
        record.currency !== null ||
        record.costBasisCents !== record.costCents ||
        record.markupSourceType !== 'legacy-global' ||
        record.markupSourceId !== null ||
        record.appliedMarkupHundredths !== null ||
        record.brandId !== null ||
        record.itemKind !== null ||
        record.pricingExplanation !== null ||
        record.ruleVersion !== 'legacy-unresolved' ||
        record.sellPriceCents < minimumSellPriceCents(record.costCents)
      ) {
        throw new PublicationValidationError('Legacy price-history provenance is invalid.');
      }
      return { ...common, ...record };
    }
    assertIdentifier(record.selectedOfferId, 'Selected supplier-offer identifier');
    assertIdentifier(record.supplierId, 'Supplier identifier');
    assertText(record.supplierName, 'Supplier name', 256);
    assertText(record.supplierSku, 'Supplier SKU', 256);
    if (!RESOLVED_GST_BASES.has(record.costGstBasis)) {
      throw new PublicationValidationError('Stored cost GST basis is invalid.');
    }
    if (!RESOLVED_GST_BASES.has(record.sellPriceGstBasis)) {
      throw new PublicationValidationError('Stored sell-price GST basis is invalid.');
    }
    if (
      record.currency !== 'AUD' ||
      !MARKUP_SOURCES.has(record.markupSourceType) ||
      !Number.isSafeInteger(record.appliedMarkupHundredths) ||
      record.appliedMarkupHundredths < 0 ||
      record.appliedMarkupHundredths > 99_999 ||
      !ITEM_KINDS.has(record.itemKind) ||
      record.ruleVersion !== 'pricing-rule-v1' ||
      record.provenanceState !== 'resolved'
    ) {
      throw new PublicationValidationError('Resolved price-history provenance is invalid.');
    }
    const markupSourceId = nullableText(
      record.markupSourceId,
      'Markup-source identifier',
      128,
      true,
    );
    const brandId = nullableText(record.brandId, 'Brand identifier', 128, true);
    assertText(record.pricingExplanation, 'Pricing explanation', 2_000);
    const costBasisCents = amountExGstCents(record.costCents, record.costGstBasis);
    const expectedSellPriceCents = deriveSellPriceCents(
      record.costCents,
      record.costGstBasis,
      record.appliedMarkupHundredths,
      record.sellPriceGstBasis,
    );
    const sellExGstCents = amountExGstCents(record.sellPriceCents, record.sellPriceGstBasis);
    if (
      record.costBasisCents !== costBasisCents ||
      record.sellPriceCents !== expectedSellPriceCents ||
      sellExGstCents < minimumSellPriceCents(costBasisCents) ||
      (record.markupSourceType === 'brand' && (brandId === null || markupSourceId !== brandId)) ||
      (record.markupSourceType === 'global' && markupSourceId !== null)
    ) {
      throw new PublicationValidationError('Resolved price-history calculation is invalid.');
    }
    return { ...common, ...record, markupSourceId, brandId };
  });
}

function validateReferenceCollection(records, itemIds) {
  if (!Array.isArray(records) || records.length > MAX_REFERENCE_RECORDS) {
    throw new PublicationValidationError(
      'Stored competitor-reference count is outside the supported range.',
    );
  }
  const identifiers = new Set();
  return records.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new PublicationValidationError('Stored competitor reference is invalid.');
    }
    assertExactKeys(
      record,
      ['attachedAt', 'id', 'itemId', 'observation'],
      'Stored competitor reference',
    );
    assertIdentifier(record.id, 'Competitor-reference identifier');
    assertIdentifier(record.itemId, 'Catalogue identifier');
    assertTimestamp(record.attachedAt, 'Competitor-reference time');
    if (identifiers.has(record.id)) {
      throw new PublicationValidationError(
        'Stored competitor-reference identifiers must be unique.',
      );
    }
    if (!itemIds.has(record.itemId)) {
      throw new PublicationValidationError(
        'Stored competitor reference names a missing catalogue item.',
      );
    }
    identifiers.add(record.id);
    return {
      id: record.id,
      itemId: record.itemId,
      observation: validateReferenceObservation(record.observation),
      attachedAt: record.attachedAt,
    };
  });
}

function fileSnapshot(path) {
  return existsSync(path)
    ? { existed: true, content: readFileSync(path, 'utf8') }
    : { existed: false, content: '' };
}

function writeDurably(path, content) {
  const handle = openSync(path, 'w');
  try {
    writeFileSync(handle, content, 'utf8');
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function replaceJsonAtomically(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeDurably(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function restoreSnapshot(path, snapshot) {
  if (snapshot.existed) writeDurably(path, snapshot.content);
  else if (existsSync(path)) unlinkSync(path);
}

function parseJsonlContent(content) {
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

function validateRecoverySnapshot(snapshot, name) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new PublicationValidationError(`The ${name} recovery snapshot is invalid.`);
  }
  assertExactKeys(snapshot, ['content', 'existed'], `${name} recovery snapshot`);
  if (typeof snapshot.existed !== 'boolean' || typeof snapshot.content !== 'string') {
    throw new PublicationValidationError(`The ${name} recovery snapshot is invalid.`);
  }
  if (!snapshot.existed && snapshot.content !== '') {
    throw new PublicationValidationError(`The ${name} recovery snapshot is inconsistent.`);
  }
  return snapshot;
}

function validateRecoveryJournal(journal) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) {
    throw new PublicationValidationError('The catalogue publication recovery journal is invalid.');
  }
  assertExactKeys(journal, ['before', 'version'], 'Recovery journal');
  if (
    journal.version !== 1 ||
    !journal.before ||
    typeof journal.before !== 'object' ||
    Array.isArray(journal.before)
  ) {
    throw new PublicationValidationError('The catalogue publication recovery journal is invalid.');
  }
  assertExactKeys(journal.before, ['approvals', 'history', 'items'], 'Recovery journal snapshots');
  const snapshots = {
    items: validateRecoverySnapshot(journal.before.items, 'catalogue'),
    approvals: validateRecoverySnapshot(journal.before.approvals, 'approval'),
    history: validateRecoverySnapshot(journal.before.history, 'price-history'),
  };
  const items = validateCatalogueCollection(
    snapshots.items.existed ? JSON.parse(snapshots.items.content) : [],
  );
  const itemIds = new Set(items.map((item) => item.id));
  const approvals = validateApprovalCollection(
    snapshots.approvals.existed ? parseJsonlContent(snapshots.approvals.content) : [],
    itemIds,
  );
  validatePriceHistoryCollection(
    snapshots.history.existed ? parseJsonlContent(snapshots.history.content) : [],
    itemIds,
    approvals,
  );
  return snapshots;
}

function recoverPublicationTransaction(paths) {
  if (!existsSync(paths.publicationJournal)) return;
  const journal = readJson(paths.publicationJournal, null);
  const snapshots = validateRecoveryJournal(journal);
  for (const name of ['items', 'approvals', 'history']) {
    restoreSnapshot(paths[name], snapshots[name]);
  }
  unlinkSync(paths.publicationJournal);
}

function writePublicationJournal(path, before) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeDurably(temporary, JSON.stringify({ version: 1, before }));
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const paths = {
    items: join(dataDir, 'catalogue-items.json'),
    history: join(dataDir, 'price-history.jsonl'),
    approvals: join(dataDir, 'approvals.jsonl'),
    references: join(dataDir, 'competitor-references.jsonl'),
    sources: join(dataDir, 'source-registry.json'),
    publicationJournal: join(dataDir, '.catalogue-publication-rollback.json'),
  };

  recoverPublicationTransaction(paths);

  return {
    dataDir,

    listItems() {
      return validateCatalogueCollection(readJson(paths.items, []));
    },
    getItem(id) {
      return this.listItems().find((item) => item.id === id) ?? null;
    },
    /** Create or replace a catalogue item. Amounts are integer cents. */
    putItem(item) {
      const canonical = validateCatalogueItem(item);
      const items = this.listItems().filter((existing) => existing.id !== canonical.id);
      if (items.some((existing) => existing.itemNumber === canonical.itemNumber)) {
        throw new PublicationValidationError('The item number is already assigned.');
      }
      const stored = { ...canonical, updatedAt: new Date().toISOString() };
      items.push(stored);
      items.sort((a, b) => a.id.localeCompare(b.id));
      replaceJsonAtomically(paths.items, items);
      return stored;
    },

    /** Metadata-only update. Creating an item or changing money requires publication approval. */
    updateItemMetadata(item) {
      const canonical = validateCatalogueItem(item);
      const existing = this.getItem(canonical.id);
      if (!existing) {
        throw new PublicationValidationError(
          'New catalogue items require an approved publication transaction.',
        );
      }
      if (
        existing.costCents !== canonical.costCents ||
        existing.sellPriceCents !== canonical.sellPriceCents
      ) {
        throw new PublicationValidationError(
          'Cost and sell price changes require an approved publication transaction.',
        );
      }
      return this.putItem({ ...existing, ...canonical });
    },

    /**
     * Validate a complete operator-approved batch before changing any file.
     * A durable rollback journal makes a crash or write error recover the
     * previous catalogue, approvals and history together on the next start.
     */
    publishApprovedChanges(changes) {
      if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_BATCH_RECORDS) {
        throw new PublicationValidationError(
          'The approved publication batch size is outside the supported range.',
        );
      }

      const currentItems = this.listItems();
      const currentApprovals = this.listApprovals();
      const currentHistory = this.listPriceHistory();
      const itemIds = new Set();
      const itemNumbers = new Set();
      const existingItemNumbers = new Map(
        currentItems.map((item) => [item.itemNumber ?? item.sku, item.id]),
      );
      const now = new Date().toISOString();
      const published = [];

      for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
          throw new PublicationValidationError('Approved publication entry is invalid.');
        }
        assertAllowedKeys(
          change,
          ['approvedBy', 'item', 'pricingProvenance'],
          ['reason'],
          'Approved publication entry',
        );
        const item = validatePublishedCatalogueItem(change.item);
        const pricingProvenance = validatePricingProvenance(change.pricingProvenance, item);
        assertText(change.approvedBy, 'Approver', 128);
        assertText(change.reason ?? '', 'Approval reason', 1_000, true);
        if (itemIds.has(item.id) || itemNumbers.has(item.itemNumber)) {
          throw new PublicationValidationError(
            'The approved publication batch contains duplicate identifiers.',
          );
        }
        itemIds.add(item.id);
        itemNumbers.add(item.itemNumber);
        const existingOwner = existingItemNumbers.get(item.itemNumber);
        if (existingOwner && existingOwner !== item.id) {
          throw new PublicationValidationError('The item number is already assigned.');
        }
        const approval = {
          id: randomUUID(),
          itemId: item.id,
          approvedBy: change.approvedBy,
          proposedSellCents: item.sellPriceCents,
          reason: change.reason ?? '',
          approvedAt: now,
        };
        const priceHistory = {
          id: randomUUID(),
          itemId: item.id,
          costCents: item.costCents,
          sellPriceCents: item.sellPriceCents,
          cost: centsToAmount(item.costCents),
          sellPrice: centsToAmount(item.sellPriceCents),
          approvalId: approval.id,
          selectedOfferId: pricingProvenance.selectedOfferId,
          supplierId: pricingProvenance.supplierId,
          supplierName: pricingProvenance.supplierName,
          supplierSku: pricingProvenance.supplierSku,
          costGstBasis: pricingProvenance.costGstBasis,
          sellPriceGstBasis: pricingProvenance.sellPriceGstBasis,
          currency: pricingProvenance.currency,
          costBasisCents: pricingProvenance.costExGstCents,
          markupSourceType: pricingProvenance.markupSource,
          markupSourceId: pricingProvenance.markupSourceId,
          appliedMarkupHundredths: pricingProvenance.markupHundredths,
          brandId: pricingProvenance.brandId,
          itemKind: pricingProvenance.itemKind,
          pricingExplanation: pricingProvenance.explanation,
          ruleVersion: pricingProvenance.ruleVersion,
          provenanceState: 'resolved',
          recordedAt: now,
        };
        published.push({
          item: { ...item, updatedAt: now },
          approval,
          priceHistory,
        });
      }

      const nextItems = new Map(currentItems.map((item) => [item.id, item]));
      for (const entry of published) nextItems.set(entry.item.id, entry.item);
      const sortedItems = [...nextItems.values()].sort((a, b) => a.id.localeCompare(b.id));
      const nextApprovals = [...currentApprovals, ...published.map((entry) => entry.approval)];
      const nextHistory = [...currentHistory, ...published.map((entry) => entry.priceHistory)];
      const before = {
        items: fileSnapshot(paths.items),
        approvals: fileSnapshot(paths.approvals),
        history: fileSnapshot(paths.history),
      };

      writePublicationJournal(paths.publicationJournal, before);
      try {
        writeDurably(paths.items, JSON.stringify(sortedItems, null, 2));
        writeDurably(
          paths.approvals,
          nextApprovals.map((record) => JSON.stringify(record)).join('\n') + '\n',
        );
        writeDurably(
          paths.history,
          nextHistory.map((record) => JSON.stringify(record)).join('\n') + '\n',
        );
        unlinkSync(paths.publicationJournal);
      } catch (error) {
        for (const name of ['items', 'approvals', 'history']) {
          restoreSnapshot(paths[name], before[name]);
        }
        if (existsSync(paths.publicationJournal)) unlinkSync(paths.publicationJournal);
        throw error;
      }
      return published;
    },

    listApprovals() {
      const items = this.listItems();
      return validateApprovalCollection(
        readJsonl(paths.approvals),
        new Set(items.map((item) => item.id)),
      );
    },
    /** Record who approved what, and when. Append-only. */
    appendApproval({ itemId, approvedBy, proposedSellCents, reason }) {
      assertIdentifier(itemId, 'Catalogue identifier');
      assertText(approvedBy, 'Approver', 128);
      assertCents(proposedSellCents, 'Proposed sell price');
      assertText(reason ?? '', 'Approval reason', 1_000, true);
      if (!this.getItem(itemId)) throw new MissingCatalogueItemError();
      this.listApprovals();
      const record = {
        id: randomUUID(),
        itemId,
        approvedBy,
        proposedSellCents,
        reason: reason ?? '',
        approvedAt: new Date().toISOString(),
      };
      appendFileSync(paths.approvals, `${JSON.stringify(record)}\n`);
      return record;
    },

    listPriceHistory(itemId) {
      const items = this.listItems();
      const approvals = this.listApprovals();
      const all = validatePriceHistoryCollection(
        readJsonl(paths.history),
        new Set(items.map((item) => item.id)),
        approvals,
      );
      return itemId ? all.filter((v) => v.itemId === itemId) : all;
    },
    /**
     * Append a published price version. The ONLY write path for prices:
     *  - refuses without an existing approval record (approvalId);
     *  - refuses a sell price below the item's floor (cost x 1.30).
     */
    appendPriceVersion({ itemId, costCents, sellPriceCents, approvalId, recordedAt }) {
      assertIdentifier(itemId, 'Catalogue identifier');
      assertIdentifier(approvalId, 'Approval identifier');
      assertCents(costCents, 'Cost');
      assertCents(sellPriceCents, 'Sell price');
      if (recordedAt !== undefined) assertTimestamp(recordedAt, 'Recorded time');
      if (!this.getItem(itemId)) throw new MissingCatalogueItemError();
      const approval = this.listApprovals().find((a) => a.id === approvalId);
      if (!approval || approval.itemId !== itemId || approval.proposedSellCents !== sellPriceCents)
        throw new MissingApprovalError();
      const floor = minimumSellPriceCents(costCents);
      if (sellPriceCents < floor) throw new FloorViolationError(sellPriceCents, floor);
      this.listPriceHistory();
      const version = {
        id: randomUUID(),
        itemId,
        costCents,
        sellPriceCents,
        cost: centsToAmount(costCents),
        sellPrice: centsToAmount(sellPriceCents),
        approvalId,
        recordedAt: recordedAt ?? new Date().toISOString(),
      };
      appendFileSync(paths.history, `${JSON.stringify(version)}\n`);
      const item = this.getItem(itemId);
      if (item) this.putItem({ ...item, costCents, sellPriceCents });
      return version;
    },

    listReferences(itemId) {
      const items = this.listItems();
      const all = validateReferenceCollection(
        readJsonl(paths.references),
        new Set(items.map((item) => item.id)),
      );
      return itemId ? all.filter((ref) => ref.itemId === itemId) : all;
    },
    /**
     * Attach a competitor price to an item as REFERENCE ONLY. This function
     * deliberately never touches catalogue-items.json or price-history.jsonl,
     * so it is provably incapable of altering a cost or sell price.
     */
    appendReference(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new PublicationValidationError('The competitor reference is invalid.');
      }
      assertExactKeys(input, ['itemId', 'observation'], 'Competitor reference');
      const { itemId } = input;
      assertIdentifier(itemId, 'Catalogue identifier');
      if (!this.getItem(itemId)) throw new MissingCatalogueItemError();
      this.listReferences();
      const observation = validateReferenceObservation(input.observation);
      const record = {
        id: randomUUID(),
        itemId,
        observation,
        attachedAt: new Date().toISOString(),
      };
      appendFileSync(paths.references, `${JSON.stringify(record)}\n`);
      return record;
    },

    getSources(fallback = []) {
      return validateSourceRegistry(readJson(paths.sources, fallback));
    },
    putSources(sources) {
      const validated = validateSourceRegistry(sources);
      if (existsSync(paths.sources)) this.getSources();
      replaceJsonAtomically(paths.sources, validated);
      return validated;
    },
  };
}
