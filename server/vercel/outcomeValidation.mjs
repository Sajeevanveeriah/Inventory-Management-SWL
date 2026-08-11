import { z } from "zod";
import { centsToAmount } from "../lib/moneyCents.mjs";

const MAX_CENTS = 1_000_000_000;
const RESULT_STATES = new Set(["ok", "no_comparable_offers"]);
const MONEY_PAIRS = [
  ["priceCents", "priceAud"],
  ["itemPriceCents", "itemPriceAud"],
  ["shippingCents", "shippingAud"],
  ["estimatedTaxCents", "estimatedTaxAud"],
  ["totalPriceCents", "totalPriceAud"],
  ["comparisonPriceCents", "comparisonPriceAud"],
];

const boundedText = (maximum) => z.string().min(1).max(maximum);
const timestamp = boundedText(64);
const cents = z.number().int().min(0).max(MAX_CENTS);
const audAmount = z.string().regex(/^\d+(?:\.\d{2})$/u);

const httpsUrl = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.port === ""
      );
    } catch {
      return false;
    }
  });

function normalisedHostname(value) {
  return value.toLowerCase().replace(/\.$/u, "");
}

function intermediaryHostname(value) {
  const host = normalisedHostname(value);
  return (
    host === "serpapi.com" ||
    host.endsWith(".serpapi.com") ||
    host === "google.com" ||
    host.endsWith(".google.com") ||
    host === "google.com.au" ||
    host.endsWith(".google.com.au") ||
    host === "googleadservices.com" ||
    host.endsWith(".googleadservices.com")
  );
}

const candidateSchema = z
  .object({
    token: boundedText(8_192),
    title: boundedText(1_000),
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
  .strict()
  .superRefine((candidate, context) => {
    const host = normalisedHostname(new URL(candidate.productUrl).hostname);
    if (!(
      host === "google.com" ||
      host.endsWith(".google.com") ||
      host === "google.com.au" ||
      host.endsWith(".google.com.au")
    )) {
      context.addIssue({
        code: "custom",
        path: ["productUrl"],
        message: "A cached candidate must use a Google product URL.",
      });
    }
  });

const resultSchema = z
  .object({
    title: boundedText(1_000),
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
    gstBasis: z.enum(["inc-gst", "ex-gst", "unknown"]),
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
    searchQuery: z.string().max(512).nullish(),
    selectedProductTitle: z.string().max(1_000).nullish(),
    selectedProductBrand: z.string().max(256).nullish(),
    selectedProductId: z.string().max(256).nullish(),
  })
  .strict()
  .superRefine((result, context) => {
    const issue = (path, message) =>
      context.addIssue({ code: "custom", path, message });

    for (const [centsField, audField] of MONEY_PAIRS) {
      const centsValue = result[centsField];
      const audValue = result[audField];
      if ((centsValue === null) !== (audValue === null)) {
        issue([audField], "Cached money components must share nullability.");
      } else if (
        centsValue !== null &&
        audValue !== centsToAmount(centsValue)
      ) {
        issue([audField], "Cached AUD text must exactly represent its cents.");
      }
    }

    if (result.priceCents !== result.itemPriceCents) {
      issue(["priceCents"], "The legacy price alias must equal item price.");
    }

    if (result.comparisonEligible) {
      if (
        result.exclusionReasons.length !== 0 ||
        result.comparisonPriceCents === null ||
        result.priceBasis === "not_comparable" ||
        (result.priceBasis === "provider_total" &&
          result.comparisonPriceCents !== result.totalPriceCents) ||
        (result.priceBasis === "item_plus_shipping" &&
          (result.shippingCents === null ||
            (result.estimatedTaxCents !== null &&
              result.estimatedTaxCents !== 0) ||
            result.comparisonPriceCents !==
              result.itemPriceCents + result.shippingCents)) ||
        (result.financing && result.totalPriceCents === null) ||
        result.condition === "used" ||
        result.availability === "out-of-stock"
      ) {
        issue([], "Cached comparison eligibility is contradictory.");
      }
    } else if (
      result.comparisonPriceCents !== null ||
      result.priceBasis !== "not_comparable" ||
      result.exclusionReasons.length === 0
    ) {
      issue([], "A cached excluded offer has contradictory comparison data.");
    }

    const urlHost = new URL(result.url).hostname.toLowerCase();
    if (
      urlHost !== result.sourceDomain.toLowerCase() ||
      intermediaryHostname(urlHost)
    ) {
      issue(["url"], "Cached source-domain evidence is contradictory.");
    }

    const hasQuery = typeof result.searchQuery === "string";
    const hasTitle = typeof result.selectedProductTitle === "string";
    if (
      hasQuery !== hasTitle ||
      (!hasQuery &&
        (result.selectedProductBrand != null ||
          result.selectedProductId != null))
    ) {
      issue([], "Cached provenance fields are incomplete.");
    }
  });

const selectedProductSchema = z
  .object({
    title: boundedText(1_000),
    brand: z.string().max(256).nullable(),
    productId: z.string().max(256).nullable(),
  })
  .strict();

const bandSchema = z
  .object({
    lowest: audAmount,
    median: audAmount,
    highest: audAmount,
    lowestCents: cents,
    medianCents: cents,
    highestCents: cents,
    pricedResults: z.number().int().min(0).max(100),
  })
  .strict();

const coverageSchema = z
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
  .strict();

const cacheableOutcomeSchema = z
  .object({
    state: z.enum([
      "ok",
      "empty",
      "selection_required",
      "no_comparable_offers",
    ]),
    query: boundedText(512),
    queryKind: z.enum(["identifier", "barcode", "free-text"]),
    provider: boundedText(128),
    candidates: z.array(candidateSchema).max(100),
    selectedProduct: selectedProductSchema.nullish(),
    results: z.array(resultSchema).max(100),
    band: bandSchema.nullable(),
    retrievedAt: timestamp,
    cached: z.boolean(),
    detail: z.string().max(1_000).nullish(),
    coverage: coverageSchema,
  })
  .strict()
  .superRefine((outcome, context) => {
    const issue = (path, message) =>
      context.addIssue({ code: "custom", path, message });
    const isResultState = RESULT_STATES.has(outcome.state);
    if (isResultState !== (outcome.selectedProduct != null)) {
      issue(
        ["selectedProduct"],
        "Cached result states require selected-product metadata.",
      );
    }
    if (
      (outcome.state === "selection_required") !==
      outcome.candidates.length > 0
    ) {
      issue(
        ["candidates"],
        "Cached selection state and candidates are contradictory.",
      );
    }
    if (!isResultState && outcome.results.length !== 0) {
      issue(["results"], "Only cached result states may contain offers.");
    }

    const eligiblePrices = outcome.results.flatMap((result) =>
      result.comparisonEligible && result.comparisonPriceCents !== null
        ? [result.comparisonPriceCents]
        : [],
    );
    if (
      (outcome.state === "ok" && eligiblePrices.length === 0) ||
      (outcome.state === "no_comparable_offers" && eligiblePrices.length > 0)
    ) {
      issue(["state"], "Cached result state contradicts offer eligibility.");
    }

    const sorted = [...eligiblePrices].sort((left, right) => left - right);
    let expectedBand = null;
    if (sorted.length > 0) {
      const middle = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 1
          ? sorted[middle]
          : Number(
              (BigInt(sorted[middle - 1]) + BigInt(sorted[middle]) + 1n) / 2n,
            );
      expectedBand = {
        lowest: centsToAmount(sorted[0]),
        median: centsToAmount(median),
        highest: centsToAmount(sorted[sorted.length - 1]),
        lowestCents: sorted[0],
        medianCents: median,
        highestCents: sorted[sorted.length - 1],
        pricedResults: sorted.length,
      };
    }
    if (JSON.stringify(outcome.band) !== JSON.stringify(expectedBand)) {
      issue(["band"], "Cached comparison band is not exactly derived.");
    }

    const domains = new Set(
      outcome.results.map((result) => normalisedHostname(result.sourceDomain)),
    );
    const coverageDomains =
      outcome.coverage.sourceDomains.map(normalisedHostname);
    const coverageMatches =
      coverageDomains.length === domains.size &&
      new Set(coverageDomains).size === coverageDomains.length &&
      coverageDomains.every((domain) => domains.has(domain));
    if (
      outcome.coverage.providerQueried !== outcome.provider ||
      outcome.coverage.sourcesWithPrice !== domains.size ||
      !coverageMatches ||
      outcome.coverage.pricedResults !== eligiblePrices.length ||
      outcome.coverage.providerCandidates !== outcome.candidates.length ||
      outcome.coverage.parsedOffers !== outcome.results.length ||
      outcome.coverage.comparableOffers !== eligiblePrices.length ||
      outcome.coverage.excludedOffers !==
        outcome.results.length - eligiblePrices.length
    ) {
      issue(["coverage"], "Cached coverage evidence is contradictory.");
    }

    const provenanceModes = new Set();
    for (const [index, result] of outcome.results.entries()) {
      if (result.retrievedAt !== outcome.retrievedAt) {
        issue(
          ["results", index, "retrievedAt"],
          "Cached result timestamps must match their outcome.",
        );
      }
      const hasProvenance = typeof result.searchQuery === "string";
      provenanceModes.add(hasProvenance ? "bound" : "legacy");
      if (hasProvenance) {
        if (
          outcome.selectedProduct == null ||
          result.searchQuery !== outcome.query ||
          result.selectedProductTitle !== outcome.selectedProduct.title ||
          (result.selectedProductBrand ?? null) !==
            outcome.selectedProduct.brand ||
          (result.selectedProductId ?? null) !==
            outcome.selectedProduct.productId
        ) {
          issue(
            ["results", index],
            "Cached result provenance does not match its outcome.",
          );
        }
      }
    }
    if (provenanceModes.size > 1) {
      issue(["results"], "Cached legacy and bound provenance cannot be mixed.");
    }
    if (
      isResultState &&
      outcome.results.length > 0 &&
      !provenanceModes.has("bound")
    ) {
      issue(["results"], "Cached result outcomes require bound provenance.");
    }
  });

export function validateCacheableSearchOutcome(value) {
  const result = cacheableOutcomeSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Redis search outcome failed semantic validation.");
  }
  return result.data;
}
