// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  applyMarkupBasisPointsHalfUp,
  DEFAULT_POLICY,
  dedupeAndFlagOutliers,
  normaliseGtin,
  normaliseMpn,
  normaliseOffer,
  recommendPrice,
  scoreProductMatch,
} from "../server/intelligence/domain.mjs";
import { minimumSellPriceCents } from "../server/lib/moneyCents.mjs";

const item = {
  gtin: "9300000000019",
  brand: "Lockwood",
  mpn: "3572-SC",
  title: "Lockwood 3572 satin chrome mortice lock",
  packQuantity: 1,
  variant: "satin chrome",
};
const raw = (overrides: Record<string, unknown> = {}) => ({
  providerId: "fixture",
  seller: "Seller A",
  url: "https://example.test/a",
  retrievedAt: "2026-08-08T00:00:00.000Z",
  amountCents: 10000,
  shippingCents: 1000,
  gstStatus: "inc-gst",
  currency: "AUD",
  condition: "new",
  availability: "in-stock",
  saleType: "fixed-price",
  ...item,
  ...overrides,
});

describe("identity normalisation and explainable matching", () => {
  it("validates GTIN checksums without changing invalid raw evidence", () => {
    expect(normaliseGtin(" 9300000000019 ").valid).toBe(true);
    expect(normaliseGtin("9300000000016")).toMatchObject({
      valid: false,
      raw: "9300000000016",
      reason: "INVALID_CHECKSUM",
    });
    expect(normaliseMpn(" 3572 / sc ")).toBe("3572-SC");
  });
  it("classifies exact, ambiguous and rejected cases with reasons", () => {
    expect(scoreProductMatch(item, raw()).classification).toBe("exact");
    expect(scoreProductMatch(item, { title: item.title }).classification).toBe(
      "ambiguous",
    );
    expect(scoreProductMatch(item, raw({ packQuantity: 2 }))).toMatchObject({
      classification: "rejected",
      reasons: expect.arrayContaining(["PACK_MISMATCH"]),
    });
    expect(
      scoreProductMatch(item, raw({ variant: "polished brass" })),
    ).toMatchObject({
      classification: "rejected",
      reasons: expect.arrayContaining(["VARIANT_MISMATCH"]),
    });
  });
});

describe("offer comparison safety", () => {
  it.each([
    [{ packQuantity: undefined }, "PACK_UNKNOWN"],
    [{ gstStatus: "unknown" }, "GST_UNKNOWN"],
    [{ shippingCents: null }, "SHIPPING_UNKNOWN"],
    [{ condition: "used" }, "CONDITION_INELIGIBLE"],
    [{ condition: "refurbished" }, "CONDITION_INELIGIBLE"],
    [{ saleType: "auction" }, "AUCTION_INELIGIBLE"],
    [{ availability: "out-of-stock" }, "NOT_AVAILABLE"],
    [{ currency: "USD" }, "CURRENCY_UNCONVERTED"],
  ])("excludes unsafe basis %#", (change, reason) => {
    expect(
      normaliseOffer(raw(change), item, { now: "2026-08-09T00:00:00.000Z" })
        .exclusions,
    ).toContain(reason);
  });
  it("normalises known GST and shipping to landed AUD per unit", () => {
    expect(
      normaliseOffer(raw({ amountCents: 10000, shippingCents: 1000 }), item, {
        now: "2026-08-09T00:00:00.000Z",
      }).landedUnitCents,
    ).toBe(11000);
    expect(
      normaliseOffer(
        raw({ amountCents: 10000, shippingCents: 1000, gstStatus: "ex-gst" }),
        item,
        {
          now: "2026-08-09T00:00:00.000Z",
        },
      ).landedUnitCents,
    ).toBe(12100);
  });
  it("deduplicates a seller-price pair and flags a robust high outlier", () => {
    const offers = [10000, 10000, 10100, 10200, 50000].map(
      (landedUnitCents, i) => ({
        ...raw({ seller: i < 2 ? "Same seller" : `Seller ${i}` }),
        eligible: true,
        landedUnitCents,
      }),
    );
    const result = dedupeAndFlagOutliers(offers);
    expect(result).toHaveLength(4);
    expect(
      result.find(
        (x: { landedUnitCents: number }) => x.landedUnitCents === 50000,
      )?.outlier,
    ).toBe(true);
  });
});

describe("versioned pricing policy", () => {
  it("uses integer half-up markup with parity to the canonical 30 percent floor", () => {
    for (const costCents of [0, 1, 2, 5, 9, 10, 99, 999, 10_000, 123_456_789]) {
      expect(applyMarkupBasisPointsHalfUp(costCents, 3_000)).toBe(
        minimumSellPriceCents(costCents),
      );
    }
    expect(applyMarkupBasisPointsHalfUp(1, 3_000)).toBe(1);
    expect(applyMarkupBasisPointsHalfUp(5, 3_000)).toBe(7);
    expect(() => applyMarkupBasisPointsHalfUp(-1, 3_000)).toThrow(RangeError);
    expect(() => applyMarkupBasisPointsHalfUp(1, 3_000.5)).toThrow(RangeError);
  });

  const offers = [10000, 10200, 10400].map((landedUnitCents, i) => ({
    ...raw({ seller: `Seller ${i}` }),
    eligible: true,
    landedUnitCents,
  }));
  it("preserves the 30% markup floor and distinguishes markup from margin", () => {
    const result = recommendPrice({
      costCents: 7000,
      currentSellCents: 11000,
      offers,
    });
    expect(DEFAULT_POLICY.floorMarkupBasisPoints).toBe(3000);
    expect(result).toMatchObject({
      state: "RECOMMENDED",
      floorCents: 9100,
      lowestCents: 10000,
      recommendationCents: 9900,
      deltaCents: 100,
    });
  });
  it("returns no recommendation when the floor prevents a strict undercut", () => {
    expect(
      recommendPrice({ costCents: 7700, currentSellCents: 11000, offers }),
    ).toMatchObject({
      state: "NO_SAFE_UNDERCUT",
      recommendationCents: null,
    });
  });
  it("gates one and two seller evidence", () => {
    expect(
      recommendPrice({ costCents: 5000, offers: offers.slice(0, 1) }).state,
    ).toBe("EVIDENCE_ONLY");
    expect(
      recommendPrice({ costCents: 5000, offers: offers.slice(0, 2) }).state,
    ).toBe("MANUAL_REVIEW_REQUIRED");
  });
});
