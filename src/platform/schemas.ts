import { z } from "zod";
import { centsToAud } from "../core/liveSearch";
import { SettingsSchema } from "../core/settings";

const boundedText = (max: number) => z.string().min(1).max(max);
const timestamp = z.string().min(1).max(64);
const cents = z.number().int().min(0).max(1_000_000_000);
const gstBasis = z.enum(["inc-gst", "ex-gst", "unknown"]);
const httpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === ""
      );
    } catch {
      return false;
    }
  }, "A credential-free HTTPS URL is required.");

const columnIndex = z.number().int().min(0).max(4095);
// These enumerations must stay in step with SupplierFieldKey and S8FieldKey in
// src/core/fields.ts; a field missing here makes every profile that uses it
// fail validation and become unsaveable. src/core/fields.test.ts asserts it.
export const SUPPLIER_MAPPING_KEYS = [
  "supplierCode",
  "supplierDescription",
  "supplierCost",
  "supplierBarcode",
  "supplierCategory",
] as const;
export const SERVICEM8_MAPPING_KEYS = [
  "itemNumber",
  "itemDescription",
  "existingCost",
  "existingSellPrice",
  "priceIncludesTaxes",
  "taxRate",
  "quantityInStock",
  "itemIsInventoried",
  "barcode",
] as const;
const SupplierMappingSchema = z.partialRecord(
  z.enum(SUPPLIER_MAPPING_KEYS),
  columnIndex,
);
const Servicem8MappingSchema = z.partialRecord(
  z.enum(SERVICEM8_MAPPING_KEYS),
  columnIndex,
);
export const MappingProfileSchema = z
  .object({
    id: boundedText(128),
    name: boundedText(160),
    version: z.number().int().min(1).max(1_000_000),
    supplierMapping: SupplierMappingSchema,
    supplierHeaders: z.array(z.string().max(512)).max(512),
    servicem8Mapping: Servicem8MappingSchema,
    servicem8Headers: z.array(z.string().max(512)).max(512),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const AliasRecordSchema = z
  .object({
    supplierCode: boundedText(128),
    itemNumber: boundedText(128),
    approvedAt: timestamp,
  })
  .strict();

export const CatalogueItemSchema = z
  .object({
    id: boundedText(128),
    itemNumber: boundedText(128),
    description: z.string().max(2000),
    costCents: cents,
    sellPriceCents: cents,
    gstBasis,
    updatedAt: timestamp,
  })
  .strict();

export const ApprovalRecordSchema = z
  .object({
    id: boundedText(128),
    itemId: boundedText(128),
    approvedBy: boundedText(128),
    proposedSellCents: cents,
    reason: z.string().max(1000),
    approvedAt: timestamp,
  })
  .strict();

export const PriceHistoryVersionSchema = z
  .object({
    id: boundedText(128),
    itemId: boundedText(128),
    cost: z.string().max(32),
    sellPrice: z.string().max(32),
    costCents: cents,
    sellPriceCents: cents,
    approvalId: boundedText(128),
    recordedAt: timestamp,
  })
  .strict();

export const PublishedChangeSchema = z
  .object({
    item: CatalogueItemSchema,
    approval: ApprovalRecordSchema,
    priceHistory: PriceHistoryVersionSchema,
  })
  .strict();

const audAmount = z.string().regex(/^\d+(?:\.\d{2})$/);

const MONEY_COMPONENT_PAIRS = [
  ["priceCents", "priceAud"],
  ["itemPriceCents", "itemPriceAud"],
  ["shippingCents", "shippingAud"],
  ["estimatedTaxCents", "estimatedTaxAud"],
  ["totalPriceCents", "totalPriceAud"],
  ["comparisonPriceCents", "comparisonPriceAud"],
] as const;

const RESULT_STATES = new Set(["ok", "no_comparable_offers"]);

function normalisedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, "");
}

function isIntermediaryHostname(hostname: string): boolean {
  const normalised = normalisedHostname(hostname);
  return (
    normalised === "serpapi.com" ||
    normalised.endsWith(".serpapi.com") ||
    normalised === "google.com" ||
    normalised.endsWith(".google.com") ||
    normalised === "google.com.au" ||
    normalised.endsWith(".google.com.au") ||
    normalised === "googleadservices.com" ||
    normalised.endsWith(".googleadservices.com")
  );
}

function derivedComparisonBand(prices: number[]) {
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianCents =
    sorted.length % 2 === 1
      ? sorted[middle]!
      : Math.floor((sorted[middle - 1]! + sorted[middle]! + 1) / 2);
  const lowestCents = sorted[0]!;
  const highestCents = sorted[sorted.length - 1]!;
  return {
    lowest: centsToAud(lowestCents),
    median: centsToAud(medianCents),
    highest: centsToAud(highestCents),
    lowestCents,
    medianCents,
    highestCents,
    pricedResults: sorted.length,
  };
}

export const LiveProductCandidateSchema = z
  .object({
    token: boundedText(8192),
    title: boundedText(1000),
    brand: z.string().max(256).nullable(),
    productId: z.string().max(256).nullable(),
    productUrl: httpsUrl,
    displayedPrice: z.string().max(64).nullable(),
    priceCents: cents.nullable(),
    multipleSources: z.boolean(),
    packSize: z.string().max(256).nullable(),
    condition: z.enum(["new", "used", "unknown"]),
    position: z.number().int().min(0).max(10_000),
  })
  .strict();

export const LiveSearchResultSchema = z
  .object({
    searchQuery: boundedText(512).nullish(),
    selectedProductTitle: boundedText(1000).nullish(),
    selectedProductBrand: z.string().max(256).nullish(),
    selectedProductId: z.string().max(256).nullish(),
    title: boundedText(1000),
    priceCents: cents,
    priceAud: audAmount,
    itemPriceCents: cents,
    itemPriceAud: audAmount,
    shippingCents: cents.nullable(),
    shippingAud: audAmount.nullable(),
    estimatedTaxCents: cents.nullable(),
    estimatedTaxAud: audAmount.nullable(),
    totalPriceCents: cents.nullable(),
    totalPriceAud: audAmount.nullable(),
    comparisonPriceCents: cents.nullable(),
    comparisonPriceAud: audAmount.nullable(),
    priceBasis: z.enum([
      "provider_total",
      "item_plus_shipping",
      "not_comparable",
    ]),
    originalPriceText: z.string().max(64),
    currencyBasis: z.enum(["explicit-aud", "inferred-au-localisation"]),
    currency: z.literal("AUD"),
    gstBasis,
    packSize: z.string().max(256).nullable(),
    condition: z.enum(["new", "used", "unknown"]),
    availability: z.enum(["in-stock", "out-of-stock", "unknown"]),
    financing: z.boolean(),
    comparisonEligible: z.boolean(),
    exclusionReasons: z.array(boundedText(128)).max(20),
    seller: boundedText(512),
    sourceDomain: boundedText(253),
    url: httpsUrl,
    retrievedAt: timestamp,
  })
  .strict()
  .superRefine((result, context) => {
    const addIssue = (path: Array<string | number>, message: string) => {
      context.addIssue({ code: "custom", path, message });
    };

    const hasSearchQuery = result.searchQuery != null;
    const hasSelectedProductTitle = result.selectedProductTitle != null;
    const hasSelectedProductDetails =
      result.selectedProductBrand != null || result.selectedProductId != null;
    if (
      hasSearchQuery !== hasSelectedProductTitle ||
      (!hasSearchQuery && hasSelectedProductDetails)
    ) {
      addIssue(
        ["searchQuery"],
        "Selection provenance requires both the search query and selected-product title.",
      );
    }

    for (const [centsField, audField] of MONEY_COMPONENT_PAIRS) {
      const centsValue = result[centsField];
      const audValue = result[audField];
      if ((centsValue === null) !== (audValue === null)) {
        addIssue(
          [audField],
          `${audField} must be null exactly when ${centsField} is null.`,
        );
      } else if (centsValue !== null && audValue !== centsToAud(centsValue)) {
        addIssue(
          [audField],
          `${audField} must exactly represent ${centsField}.`,
        );
      }
    }
    if (
      result.priceCents !== result.itemPriceCents ||
      result.priceAud !== result.itemPriceAud
    ) {
      addIssue(
        ["priceCents"],
        "The backwards-compatible price must equal the item price.",
      );
    }

    if (result.comparisonEligible) {
      if (result.exclusionReasons.length !== 0) {
        addIssue(
          ["exclusionReasons"],
          "An eligible offer cannot have exclusion reasons.",
        );
      }
      if (result.comparisonPriceCents === null) {
        addIssue(
          ["comparisonPriceCents"],
          "An eligible offer requires a comparison price.",
        );
      }
      if (result.priceBasis === "not_comparable") {
        addIssue(
          ["priceBasis"],
          "An eligible offer requires a comparable price basis.",
        );
      } else if (
        result.priceBasis === "provider_total" &&
        result.comparisonPriceCents !== result.totalPriceCents
      ) {
        addIssue(
          ["comparisonPriceCents"],
          "A provider-total comparison must equal the provider total.",
        );
      } else if (
        result.priceBasis === "item_plus_shipping" &&
        (result.shippingCents === null ||
          result.comparisonPriceCents !==
            result.itemPriceCents + result.shippingCents ||
          (result.estimatedTaxCents !== null && result.estimatedTaxCents !== 0))
      ) {
        addIssue(
          ["comparisonPriceCents"],
          "An item-plus-shipping comparison must equal both components and cannot omit known tax.",
        );
      }

      if (result.financing && result.totalPriceCents === null) {
        addIssue(
          ["financing"],
          "Financing without a full total cannot be comparison eligible.",
        );
      }
      if (result.condition === "used") {
        addIssue(["condition"], "A used offer cannot be comparison eligible.");
      }
      if (result.availability === "out-of-stock") {
        addIssue(
          ["availability"],
          "An out-of-stock offer cannot be comparison eligible.",
        );
      }
    } else {
      if (result.comparisonPriceCents !== null) {
        addIssue(
          ["comparisonPriceCents"],
          "An excluded offer cannot have a comparison price.",
        );
      }
      if (result.priceBasis !== "not_comparable") {
        addIssue(
          ["priceBasis"],
          "An excluded offer must use the not-comparable price basis.",
        );
      }
      if (result.exclusionReasons.length === 0) {
        addIssue(
          ["exclusionReasons"],
          "An excluded offer requires at least one exclusion reason.",
        );
      }
    }

    let resultUrl: URL;
    try {
      resultUrl = new URL(result.url);
    } catch {
      return;
    }
    const urlHostname = resultUrl.hostname.toLowerCase();
    if (resultUrl.host.toLowerCase() !== result.sourceDomain.toLowerCase()) {
      addIssue(
        ["url"],
        "The result URL host must equal its declared source domain.",
      );
    }
    if (isIntermediaryHostname(urlHostname)) {
      addIssue(
        ["url"],
        "The result URL must identify a merchant rather than an intermediary.",
      );
    }
  });

export const CompetitorObservationSchema = z
  .object({
    sku: boundedText(128),
    sourceName: boundedText(256),
    approvedSource: z.boolean(),
    observedAt: timestamp,
    price: z
      .string()
      .regex(/^\d+(?:\.\d{1,2})?$/)
      .max(32),
    currency: z.literal("AUD"),
    gstBasis,
    shipping: z
      .string()
      .regex(/^\d+(?:\.\d{1,2})?$/)
      .max(32),
    stockStatus: z.enum(["in-stock", "out-of-stock", "unknown"]),
    condition: z.enum(["new", "used", "unknown"]),
    packCompatible: z.boolean(),
    productOnly: z.boolean(),
    matchConfidence: z.number().min(0).max(1),
    reviewState: z.enum(["accepted", "rejected", "quarantined"]),
    ambiguousMatch: z.boolean().optional(),
    url: httpsUrl.optional(),
    packSize: z.string().max(256).optional(),
  })
  .strict();

export const LiveSearchOutcomeSchema = z
  .object({
    state: z.enum([
      "ok",
      "empty",
      "selection_required",
      "selection_expired",
      "no_comparable_offers",
      "not_configured",
      "offline",
      "timeout",
      "provider_error",
      "quota_exhausted",
      "rate_limited",
      "search_in_progress",
      "invalid_query",
      "server_unreachable",
    ]),
    query: z.string().max(512),
    queryKind: z.enum(["identifier", "barcode", "free-text", "empty"]),
    provider: z.string().max(128),
    candidates: z.array(LiveProductCandidateSchema).max(100),
    selectedProduct: z
      .object({
        title: boundedText(1000),
        brand: z.string().max(256).nullable(),
        productId: z.string().max(256).nullable(),
      })
      .strict()
      .nullish(),
    results: z.array(LiveSearchResultSchema).max(100),
    band: z
      .object({
        lowest: audAmount,
        median: audAmount,
        highest: audAmount,
        lowestCents: cents,
        medianCents: cents,
        highestCents: cents,
        pricedResults: z.number().int().min(0).max(100),
      })
      .strict()
      .nullable(),
    retrievedAt: timestamp.nullish(),
    cached: z.boolean().nullish(),
    detail: z.string().max(1000).nullish(),
    coverage: z
      .object({
        providerQueried: z.string().max(128),
        sourcesWithPrice: z.number().int().min(0).max(100),
        sourceDomains: z.array(z.string().max(253)).max(100),
        pricedResults: z.number().int().min(0).max(100),
        providerCandidates: z.number().int().min(0).max(100),
        parsedOffers: z.number().int().min(0).max(100),
        comparableOffers: z.number().int().min(0).max(100),
        excludedOffers: z.number().int().min(0).max(100),
      })
      .strict()
      .nullish(),
  })
  .strict()
  .superRefine((outcome, context) => {
    const addIssue = (path: Array<string | number>, message: string) => {
      context.addIssue({ code: "custom", path, message });
    };

    const requiresSelectedProduct = RESULT_STATES.has(outcome.state);
    if (requiresSelectedProduct && outcome.selectedProduct == null) {
      addIssue(
        ["selectedProduct"],
        "A result outcome requires selected-product metadata.",
      );
    } else if (!requiresSelectedProduct && outcome.selectedProduct != null) {
      addIssue(
        ["selectedProduct"],
        "Selected-product metadata is only valid for result outcomes.",
      );
    }

    if (requiresSelectedProduct) {
      for (const [index, result] of outcome.results.entries()) {
        if (result.searchQuery == null || result.selectedProductTitle == null) {
          addIssue(
            ["results", index, "searchQuery"],
            "Every live result requires immutable selection provenance.",
          );
          continue;
        }
        if (result.searchQuery !== outcome.query) {
          addIssue(
            ["results", index, "searchQuery"],
            "Result provenance must match the outcome query.",
          );
        }
        if (outcome.selectedProduct != null) {
          if (result.selectedProductTitle !== outcome.selectedProduct.title) {
            addIssue(
              ["results", index, "selectedProductTitle"],
              "Result provenance must match the selected-product title.",
            );
          }
          if (
            (result.selectedProductBrand ?? null) !==
            outcome.selectedProduct.brand
          ) {
            addIssue(
              ["results", index, "selectedProductBrand"],
              "Result provenance must match the selected-product brand.",
            );
          }
          if (
            (result.selectedProductId ?? null) !==
            outcome.selectedProduct.productId
          ) {
            addIssue(
              ["results", index, "selectedProductId"],
              "Result provenance must match the selected-product identifier.",
            );
          }
        }
      }
    }

    const eligiblePrices = outcome.results.flatMap((result) =>
      result.comparisonEligible && result.comparisonPriceCents !== null
        ? [result.comparisonPriceCents]
        : [],
    );
    const expectedBand = derivedComparisonBand(eligiblePrices);
    if (expectedBand === null) {
      if (outcome.band !== null) {
        addIssue(
          ["band"],
          "The comparison band must be null without comparable offers.",
        );
      }
    } else if (outcome.band === null) {
      addIssue(
        ["band"],
        "Comparable offers require an exactly derived comparison band.",
      );
    } else {
      for (const field of [
        "lowest",
        "median",
        "highest",
        "lowestCents",
        "medianCents",
        "highestCents",
        "pricedResults",
      ] as const) {
        if (outcome.band[field] !== expectedBand[field]) {
          addIssue(
            ["band", field],
            "The comparison band must exactly match eligible comparison prices.",
          );
        }
      }
    }

    if (outcome.coverage != null) {
      const comparableOffers = eligiblePrices.length;
      const expectedCoverage = {
        pricedResults: comparableOffers,
        providerCandidates: outcome.candidates.length,
        parsedOffers: outcome.results.length,
        comparableOffers,
        excludedOffers: outcome.results.length - comparableOffers,
      };
      if (outcome.coverage.providerQueried !== outcome.provider) {
        addIssue(
          ["coverage", "providerQueried"],
          "Coverage must identify the outcome provider.",
        );
      }
      for (const field of [
        "pricedResults",
        "providerCandidates",
        "parsedOffers",
        "comparableOffers",
        "excludedOffers",
      ] as const) {
        if (outcome.coverage[field] !== expectedCoverage[field]) {
          addIssue(
            ["coverage", field],
            "Coverage counts must exactly match candidates and results.",
          );
        }
      }

      const resultDomains = new Set(
        outcome.results.map((result) =>
          normalisedHostname(result.sourceDomain),
        ),
      );
      const coverageDomains =
        outcome.coverage.sourceDomains.map(normalisedHostname);
      const uniqueCoverageDomains = new Set(coverageDomains);
      const domainsMatch =
        coverageDomains.length === resultDomains.size &&
        uniqueCoverageDomains.size === coverageDomains.length &&
        coverageDomains.every((domain) => resultDomains.has(domain));
      if (!domainsMatch) {
        addIssue(
          ["coverage", "sourceDomains"],
          "Coverage domains must be the unique domains in the results.",
        );
      }
      if (outcome.coverage.sourcesWithPrice !== resultDomains.size) {
        addIssue(
          ["coverage", "sourcesWithPrice"],
          "The source count must equal the unique result-domain count.",
        );
      }
    }
  });

export const LiveHealthSchema = z
  .object({
    ok: z.boolean(),
    provider: z.string().max(128),
    liveSearchConfigured: z.boolean(),
    fixtureMode: z.boolean(),
    requiresPaidCall: z.boolean().optional(),
    paidCallsEnabled: z.boolean().optional(),
    costCeilingAud: z
      .string()
      .regex(/^\d+(?:\.\d{2})$/)
      .optional(),
    costCeilingCents: z.number().int().min(0).max(1_000_000_000).optional(),
    costPerCallCents: z.number().int().min(0).max(1_000_000_000).optional(),
    spentCents: z.number().int().min(0).max(1_000_000_000).optional(),
    paidPolicyState: z
      .enum(["fixture", "disabled", "invalid", "enabled", "exhausted"])
      .optional(),
    schemaVersion: z.number().int().min(0).optional(),
  })
  .strict();

export const CompetitorSourceSchema = z
  .object({
    id: boundedText(128),
    name: boundedText(256),
    accessMethod: z.enum(["live-api", "manual-entry", "file-import"]),
    automatedAccessNote: z.string().max(2000),
    enabled: z.boolean(),
  })
  .strict();

export const CompetitorReferenceRecordSchema = z
  .object({
    id: boundedText(128),
    itemId: boundedText(128),
    observation: z.union([LiveSearchResultSchema, CompetitorObservationSchema]),
    attachedAt: timestamp,
  })
  .strict();

const ConfigurationCountsSchema = z
  .object({
    profiles: z.number().int().min(0).max(1000),
    aliases: z.number().int().min(0).max(100_000),
    settings: z.literal(1),
  })
  .strict();
const ConfigurationConflictCountsSchema = z
  .object({
    profiles: z.number().int().min(0).max(1000),
    aliases: z.number().int().min(0).max(100_000),
    settings: z.number().int().min(0).max(1),
  })
  .strict();

export const ConfigurationEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    application: z.literal("swl-pricing-inventory-control"),
    exportedAt: timestamp,
    counts: ConfigurationCountsSchema,
    data: z
      .object({
        profiles: z.array(MappingProfileSchema).max(1000),
        aliases: z.array(AliasRecordSchema).max(100_000),
        settings: SettingsSchema,
      })
      .strict(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const ConfigurationPreviewSchema = z
  .object({
    previewToken: boundedText(256),
    schemaVersion: z.number().int().min(1),
    counts: ConfigurationEnvelopeSchema.shape.counts,
    conflicts: ConfigurationConflictCountsSchema,
    valid: z.boolean(),
    validationMessages: z.array(z.string().max(500)).max(100),
  })
  .strict();

export const ConfigurationMigrationStatusSchema = z
  .object({
    legacyConfigurationFound: z.boolean(),
    alreadyImported: z.boolean(),
    counts: ConfigurationEnvelopeSchema.shape.counts,
    valid: z.boolean(),
    invalidCounts: z
      .object({
        profiles: z.number().int().min(0).max(1000),
        aliases: z.number().int().min(0).max(100_000),
        settings: z.number().int().min(0).max(1),
      })
      .strict(),
    validationMessages: z.array(z.string().max(500)).max(100),
  })
  .strict();

export const BackupRecordCountsSchema = z
  .object({
    catalogueItems: z.number().int().min(0),
    approvals: z.number().int().min(0),
    priceHistory: z.number().int().min(0),
    competitorReferences: z.number().int().min(0),
    sources: z.number().int().min(0),
    profiles: z.number().int().min(0),
    aliases: z.number().int().min(0),
    settings: z.number().int().min(0).max(1),
  })
  .strict();

export const BackupSummarySchema = z
  .object({
    id: boundedText(256),
    filename: boundedText(260),
    createdAt: timestamp,
    applicationVersion: boundedText(64),
    schemaVersion: z.number().int().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    recordCounts: BackupRecordCountsSchema,
  })
  .strict();

export const RestorePreviewSchema = BackupSummarySchema.extend({
  previewToken: boundedText(256),
  integrityOk: z.boolean(),
}).strict();

export const ResetPreviewSchema = z
  .object({
    resetToken: boundedText(256),
    confirmationPhrase: boundedText(128),
    scope: z.array(z.string().max(256)).min(1).max(32),
    recordCounts: BackupRecordCountsSchema,
  })
  .strict();

export const ProviderStatusSchema = z
  .object({
    provider: z.string().max(128),
    state: z.enum([
      "configured",
      "fixture",
      "not_configured",
      "offline",
      "timeout",
      "quota_exhausted",
      "rate_limited",
      "provider_error",
    ]),
    paidCallsEnabled: z.boolean(),
    costCeilingAud: z.string().regex(/^\d+(?:\.\d{2})$/),
    costCeilingCents: z.number().int().min(0).max(1_000_000_000),
    costPerCallCents: z.number().int().min(0).max(1_000_000_000),
    spentCents: z.number().int().min(0).max(1_000_000_000),
    credentialConfigured: z.boolean(),
    credentialHint: z.string().max(64).nullable(),
    lastValidatedAt: timestamp.nullable(),
  })
  .strict();

export const OutputDestinationGrantSchema = z
  .object({
    grantId: boundedText(256),
    displayName: boundedText(512),
  })
  .strict();

export const InputFileGrantSchema = z
  .object({
    grantId: boundedText(256),
    displayName: boundedText(720),
    length: z
      .number()
      .int()
      .min(1)
      .max(25 * 1024 * 1024),
    extension: z.enum(["csv", "xlsx", "json"]),
  })
  .strict();

export const BeginExportSchema = z
  .object({
    sessionId: boundedText(256),
    conflict: z.literal(false),
  })
  .strict();
