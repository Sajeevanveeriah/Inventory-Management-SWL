import { describe, expect, it } from "vitest";
import type { ComparisonRow } from "./compare";
import { buildExpansionCatalogue } from "./expansion";

function row(
  id: string,
  status: ComparisonRow["status"],
  category?: string,
): ComparisonRow {
  return {
    id,
    status,
    matchMethod: "none",
    supplier: {
      rowIndex: 0,
      sourceRow: 2,
      code: id,
      codeNorm: id,
      description: `Product ${id}`,
      costRaw: "10.00",
      cost: "10.00",
      barcode: "",
      ...(category === undefined ? {} : { category }),
      priceOnApplication: false,
      issues: [],
    },
    s8: null,
    proposedSell: "13.00",
    targetBasis: "excluding-gst",
    pricing: null,
    costDelta: null,
    priceDelta: null,
    duplicateSourceRows: [],
    messages: [],
    suggestions: [],
  };
}

describe("buildExpansionCatalogue", () => {
  it("groups only supplier-only items and keeps uncategorised records visible", () => {
    const categories = buildExpansionCatalogue([
      row("B-2", "new-item", "Safes"),
      row("A-1", "new-item", "Safes"),
      row("C-3", "new-item"),
      row("D-4", "price-changed", "Current range"),
    ]);

    expect(categories.map((category) => category.name)).toEqual([
      "Safes",
      "Uncategorised",
    ]);
    expect(categories[0]?.items.map((item) => item.code)).toEqual([
      "A-1",
      "B-2",
    ]);
    expect(
      categories.every((category) => category.scope === "out-of-scope"),
    ).toBe(true);
    expect(
      categories
        .flatMap((category) => category.items)
        .every((item) => item.scope === "out-of-scope"),
    ).toBe(true);
    expect(categories.flatMap((category) => category.items)).toHaveLength(3);
  });
});
