import { createHash } from "node:crypto";

export const POLICY_VERSION = "aud-undercut-v1";
export const DEFAULT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  floorMarkupBasisPoints: 3000,
  minimumSellersForRecommendation: 3,
  minimumSellersForManualReview: 2,
  minimumMatchScore: 80,
  maximumEvidenceAgeDays: 30,
  maximumUndercutCents: 100,
  undercutBasisPoints: 100,
  minimumUndercutCents: 1,
  retailEnding: "none",
});

export function applyMarkupBasisPointsHalfUp(costCents, markupBasisPoints) {
  if (
    !Number.isSafeInteger(costCents) ||
    costCents < 0 ||
    !Number.isSafeInteger(markupBasisPoints) ||
    markupBasisPoints < 0
  ) {
    throw new RangeError(
      "Cost and markup basis points must be non-negative safe integers.",
    );
  }
  const numerator = BigInt(costCents) * BigInt(10_000 + markupBasisPoints);
  const rounded = (numerator + 5_000n) / 10_000n;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      "The marked-up amount exceeds the supported integer range.",
    );
  }
  return Number(rounded);
}

export function normaliseBrand(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[™®]/g, "")
    .replace(/\s+/g, " ");
}

export function normaliseMpn(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s._/]+/g, "-")
    .replace(/-+/g, "-");
}

export function normaliseGtin(value) {
  const raw = String(value ?? "").trim();
  const digits = raw.replace(/[\s-]/g, "");
  const validLength =
    [8, 12, 13, 14].includes(digits.length) && /^\d+$/.test(digits);
  if (!validLength)
    return {
      raw,
      normalised: digits,
      valid: false,
      reason: "INVALID_LENGTH_OR_CHARACTERS",
    };
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = body.length - 1, position = 0; i >= 0; i--, position++) {
    sum += Number(body[i]) * (position % 2 === 0 ? 3 : 1);
  }
  const expected = (10 - (sum % 10)) % 10;
  return {
    raw,
    normalised: digits,
    valid: expected === Number(digits.at(-1)),
    reason:
      expected === Number(digits.at(-1))
        ? "VALID_CHECKSUM"
        : "INVALID_CHECKSUM",
  };
}

const tokens = (value) =>
  new Set(
    String(value ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  );

export function scoreProductMatch(item, candidate) {
  const reasons = [];
  let score = 0;
  const leftGtin = normaliseGtin(item.gtin);
  const rightGtin = normaliseGtin(candidate.gtin);
  if (leftGtin.valid && rightGtin.valid) {
    if (leftGtin.normalised === rightGtin.normalised) {
      score = 100;
      reasons.push("GTIN_EXACT");
    } else
      return {
        score: 0,
        classification: "rejected",
        reasons: ["GTIN_CONFLICT"],
      };
  }
  const itemMpn = normaliseMpn(item.mpn);
  const candidateMpn = normaliseMpn(candidate.mpn);
  if (itemMpn && candidateMpn) {
    if (itemMpn === candidateMpn) {
      score += 55;
      reasons.push("MPN_EXACT");
    } else {
      score -= 35;
      reasons.push("MPN_CONFLICT");
    }
  }
  if (
    normaliseBrand(item.brand) &&
    normaliseBrand(item.brand) === normaliseBrand(candidate.brand)
  ) {
    score += 20;
    reasons.push("BRAND_EXACT");
  }
  const a = tokens(`${item.model ?? ""} ${item.title ?? ""}`);
  const b = tokens(`${candidate.model ?? ""} ${candidate.title ?? ""}`);
  const union = new Set([...a, ...b]);
  const overlap = [...a].filter((x) => b.has(x)).length;
  const similarity = union.size ? overlap / union.size : 0;
  score += Math.round(similarity * 25);
  if (similarity >= 0.7) reasons.push("TITLE_ATTRIBUTES_AGREE");
  else if (similarity > 0) reasons.push("TITLE_PARTIAL");
  if (
    item.packQuantity &&
    candidate.packQuantity &&
    item.packQuantity !== candidate.packQuantity
  ) {
    return {
      score: 0,
      classification: "rejected",
      reasons: [...reasons, "PACK_MISMATCH"],
    };
  }
  if (
    item.variant &&
    candidate.variant &&
    normaliseBrand(item.variant) !== normaliseBrand(candidate.variant)
  ) {
    return {
      score: 0,
      classification: "rejected",
      reasons: [...reasons, "VARIANT_MISMATCH"],
    };
  }
  score = Math.max(0, Math.min(100, score));
  const classification =
    score >= 90
      ? "exact"
      : score >= 75
        ? "probable"
        : score >= 45
          ? "ambiguous"
          : "rejected";
  if (reasons.length === 1 && reasons[0].startsWith("TITLE"))
    return {
      score: Math.min(score, 44),
      classification: "ambiguous",
      reasons: [...reasons, "TITLE_ONLY_LOW_CONFIDENCE"],
    };
  return { score, classification, reasons };
}

export function normaliseOffer(
  offer,
  item,
  { now = new Date().toISOString(), maxAgeDays = 30 } = {},
) {
  const exclusions = [];
  const match = scoreProductMatch(item, offer);
  if (!["exact", "probable"].includes(match.classification))
    exclusions.push(
      match.classification === "ambiguous"
        ? "AMBIGUOUS_MATCH"
        : "IDENTITY_REJECTED",
    );
  if (!["new"].includes(offer.condition))
    exclusions.push("CONDITION_INELIGIBLE");
  if (offer.saleType === "auction") exclusions.push("AUCTION_INELIGIBLE");
  if (offer.availability !== "in-stock") exclusions.push("NOT_AVAILABLE");
  if (!Number.isInteger(offer.packQuantity) || offer.packQuantity < 1)
    exclusions.push("PACK_UNKNOWN");
  else if (item.packQuantity && offer.packQuantity !== item.packQuantity)
    exclusions.push("PACK_MISMATCH");
  if (offer.currency !== "AUD") exclusions.push("CURRENCY_UNCONVERTED");
  if (offer.gstStatus === "unknown") exclusions.push("GST_UNKNOWN");
  if (offer.shippingCents == null) exclusions.push("SHIPPING_UNKNOWN");
  const ageDays =
    (new Date(now).getTime() - new Date(offer.retrievedAt).getTime()) /
    86400000;
  if (!Number.isFinite(ageDays) || ageDays > maxAgeDays)
    exclusions.push("STALE");
  let landedUnitCents = null;
  if (
    !exclusions.some((x) =>
      [
        "PACK_UNKNOWN",
        "CURRENCY_UNCONVERTED",
        "GST_UNKNOWN",
        "SHIPPING_UNKNOWN",
      ].includes(x),
    )
  ) {
    const gross = offer.amountCents + offer.shippingCents;
    landedUnitCents =
      offer.gstStatus === "ex-gst" ? Math.round((gross * 110) / 100) : gross;
    landedUnitCents = Math.round(landedUnitCents / offer.packQuantity);
  }
  return {
    ...offer,
    match,
    landedUnitCents,
    eligible: exclusions.length === 0,
    exclusions,
  };
}

export function dedupeAndFlagOutliers(offers) {
  const bySeller = new Map();
  for (const offer of offers) {
    const key = `${normaliseBrand(offer.seller)}|${offer.landedUnitCents}`;
    if (!bySeller.has(key)) bySeller.set(key, offer);
  }
  const unique = [...bySeller.values()];
  const values = unique
    .filter((x) => x.eligible)
    .map((x) => x.landedUnitCents)
    .sort((a, b) => a - b);
  if (values.length < 4) return unique.map((x) => ({ ...x, outlier: false }));
  const q = (p) => values[Math.floor((values.length - 1) * p)];
  const q1 = q(0.25),
    q3 = q(0.75),
    iqr = q3 - q1;
  return unique.map((x) => ({
    ...x,
    outlier:
      x.eligible &&
      (x.landedUnitCents < q1 - 1.5 * iqr ||
        x.landedUnitCents > q3 + 1.5 * iqr),
  }));
}

export function recommendPrice({
  costCents,
  currentSellCents,
  offers,
  policy = DEFAULT_POLICY,
}) {
  if (!Number.isInteger(costCents))
    return {
      state: "MANUAL_REVIEW_REQUIRED",
      reason: "MISSING_COST",
      recommendationCents: null,
    };
  const floorCents = applyMarkupBasisPointsHalfUp(
    costCents,
    policy.floorMarkupBasisPoints,
  );
  const eligible = dedupeAndFlagOutliers(offers).filter(
    (x) => x.eligible && !x.outlier,
  );
  const sellers = new Set(eligible.map((x) => normaliseBrand(x.seller))).size;
  const sorted = eligible.map((x) => x.landedUnitCents).sort((a, b) => a - b);
  if (!sorted.length)
    return {
      state: "INSUFFICIENT_EVIDENCE",
      reason: "NO_COMPARABLE_OFFERS",
      floorCents,
      recommendationCents: null,
    };
  const lowest = sorted[0];
  const delta = Math.max(
    policy.minimumUndercutCents,
    Math.min(
      policy.maximumUndercutCents,
      Math.floor((lowest * policy.undercutBasisPoints) / 10000),
    ),
  );
  const candidate = lowest - delta;
  if (floorCents >= lowest || candidate < floorCents)
    return {
      state: "NO_SAFE_UNDERCUT",
      reason: "FLOOR_CONSTRAINED",
      floorCents,
      lowestCents: lowest,
      recommendationCents: null,
      distinctSellers: sellers,
    };
  const median = sorted[Math.floor(sorted.length / 2)];
  const q1 = sorted[Math.floor((sorted.length - 1) * 0.25)];
  const common = {
    floorCents,
    lowestCents: lowest,
    medianCents: median,
    lowerQuartileCents: q1,
    distinctSellers: sellers,
    eligibleOffers: sorted.length,
    currentSellCents,
    aggressiveCents: candidate,
    marketCents: Math.max(floorCents, q1 - delta),
    defensiveCents: Math.max(floorCents, median - delta),
    deltaCents: delta,
  };
  if (sellers < policy.minimumSellersForManualReview)
    return {
      state: "EVIDENCE_ONLY",
      reason: "ONE_SELLER",
      ...common,
      recommendationCents: null,
    };
  if (sellers < policy.minimumSellersForRecommendation)
    return {
      state: "MANUAL_REVIEW_REQUIRED",
      reason: "TWO_SELLERS",
      ...common,
      recommendationCents: null,
    };
  return {
    state: "RECOMMENDED",
    reason: "EVIDENCE_GATE_PASSED",
    ...common,
    recommendationCents: candidate,
  };
}

export function offerFingerprint(sourceId, offer) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        sourceId,
        offer.externalOfferId ?? "",
        offer.seller,
        offer.url,
        offer.amountCents,
        offer.currency,
        offer.packQuantity,
      ]),
    )
    .digest("hex");
}
