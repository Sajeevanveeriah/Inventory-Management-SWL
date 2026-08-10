// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createStore,
  FloorViolationError,
  MissingApprovalError,
  MissingCatalogueItemError,
  PublicationValidationError,
} from "../server/store/store.mjs";
import {
  centsToAmount,
  minimumSellPriceCents,
  parseAmountToCents,
} from "../server/lib/moneyCents.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "swl-store-"));
  return { dir, store: createStore(dir) };
}

function publicationFileSnapshot(dir: string) {
  return Object.fromEntries(
    ["catalogue-items.json", "approvals.jsonl", "price-history.jsonl"].map(
      (name) => {
        const path = join(dir, name);
        return [
          name,
          existsSync(path)
            ? { exists: true, bytes: readFileSync(path).toString("base64") }
            : { exists: false, bytes: "" },
        ];
      },
    ),
  );
}

function seedItem(store: ReturnType<typeof createStore>, id = "LW4570") {
  return store.putItem({
    id,
    sku: id,
    description: "Lockwood 4570 keyed deadlatch",
    costCents: 10000,
    sellPriceCents: 13000,
  });
}

function syntheticObservation(overrides: Record<string, unknown> = {}) {
  return {
    title: "Synthetic Lockwood 4570 deadlatch",
    priceCents: 9_500,
    priceAud: "95.00",
    currency: "AUD",
    gstBasis: "inc-gst",
    packSize: null,
    seller: "Fictionville Security Supplies",
    sourceDomain: "fictionville-security.example.com.au",
    url: "https://fictionville-security.example.com.au/product/lw4570",
    retrievedAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function syntheticManualObservation(overrides: Record<string, unknown> = {}) {
  return {
    sku: "LW4570",
    sourceName: "Synthetic manual evidence",
    approvedSource: true,
    observedAt: "2026-08-09T00:00:00.000Z",
    price: "95.00",
    currency: "AUD",
    gstBasis: "inc-gst",
    shipping: "0.00",
    stockStatus: "in-stock",
    condition: "new",
    packCompatible: true,
    productOnly: true,
    matchConfidence: 1,
    reviewState: "accepted",
    ambiguousMatch: false,
    url: "https://fictionville-security.example.com.au/manual/lw4570",
    packSize: "each",
    ...overrides,
  };
}

describe("server money path (integer minor units, no floats)", () => {
  it("minimumSellPrice(100.00) is exactly 130.00 AUD, plus edge values", () => {
    expect(
      centsToAmount(minimumSellPriceCents(parseAmountToCents("100")!)),
    ).toBe("130.00");
    expect(centsToAmount(minimumSellPriceCents(parseAmountToCents("0")!))).toBe(
      "0.00",
    );
    expect(
      centsToAmount(minimumSellPriceCents(parseAmountToCents("0.01")!)),
    ).toBe("0.01");
    expect(
      centsToAmount(minimumSellPriceCents(parseAmountToCents("9.99")!)),
    ).toBe("12.99");
    expect(
      centsToAmount(minimumSellPriceCents(parseAmountToCents("1234567.89")!)),
    ).toBe("1604938.26");
    expect(parseAmountToCents("10000000.00")).toBe(1_000_000_000);
    expect(parseAmountToCents("10000000.01")).toBeNull();
  });

  it("uses no floating point arithmetic in the server money modules", () => {
    for (const file of [
      "server/lib/moneyCents.mjs",
      "server/store/store.mjs",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/parseFloat|Number\.EPSILON|toPrecision/);
      expect(source).not.toMatch(/[\s(][\d.]+\s*\*\s*1\.3/);
      expect(source).not.toMatch(/\/\s*100(?!n)/); // only BigInt division by 100n
    }
  });
});

describe("publication guards", () => {
  it("exposes one atomic web publication route and no split mutation routes", () => {
    const server = readFileSync("server/index.mjs", "utf8");
    expect(server).toContain("POST /api/publish-approved-changes");
    expect(server).not.toContain("POST /api/approvals");
    expect(server).not.toContain("POST /api/price-history");
  });

  it("refuses any published price below the item floor", () => {
    const { store } = tempStore();
    seedItem(store);
    const approval = store.appendApproval({
      itemId: "LW4570",
      approvedBy: "Test operator",
      proposedSellCents: 12999,
    });
    expect(() =>
      store.appendPriceVersion({
        itemId: "LW4570",
        costCents: 10000,
        sellPriceCents: 12999,
        approvalId: approval.id,
      }),
    ).toThrow(FloorViolationError);
    expect(store.listPriceHistory("LW4570")).toHaveLength(0);
  });

  it("refuses to publish without an approval record (asserted, not assumed)", () => {
    const { store } = tempStore();
    seedItem(store);
    expect(() =>
      store.appendPriceVersion({
        itemId: "LW4570",
        costCents: 10000,
        sellPriceCents: 13000,
        approvalId: "no-such-approval",
      }),
    ).toThrow(MissingApprovalError);
    expect(store.listPriceHistory()).toHaveLength(0);
  });

  it("records who approved and when on the publish path", () => {
    const { store } = tempStore();
    seedItem(store);
    const approval = store.appendApproval({
      itemId: "LW4570",
      approvedBy: "Test operator",
      proposedSellCents: 13500,
    });
    expect(approval.approvedBy).toBe("Test operator");
    expect(approval.approvedAt).toBeTruthy();
    const version = store.appendPriceVersion({
      itemId: "LW4570",
      costCents: 10000,
      sellPriceCents: 13500,
      approvalId: approval.id,
    });
    expect(version.approvalId).toBe(approval.id);
  });

  it("rejects an approval that names a different proposed sell price", () => {
    const { store } = tempStore();
    seedItem(store);
    const approval = store.appendApproval({
      itemId: "LW4570",
      approvedBy: "Test operator",
      proposedSellCents: 13_500,
    });
    expect(() =>
      store.appendPriceVersion({
        itemId: "LW4570",
        costCents: 10_000,
        sellPriceCents: 13_501,
        approvalId: approval.id,
      }),
    ).toThrow(MissingApprovalError);
    expect(store.listPriceHistory()).toHaveLength(0);
  });

  it("publishes a validated batch with catalogue, approval and history parity", () => {
    const { store } = tempStore();
    const published = store.publishApprovedChanges([
      {
        item: {
          id: "000123",
          itemNumber: "000123",
          description: "Synthetic restricted key",
          costCents: 10_000,
          sellPriceCents: 13_000,
          gstBasis: "unknown",
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
        approvedBy: "Synthetic operator",
        reason: "Explicit test approval",
      },
      {
        item: {
          id: "000124",
          itemNumber: "000124",
          description: "Synthetic padlock",
          costCents: 9_999,
          sellPriceCents: 12_999,
          gstBasis: "inc-gst",
          updatedAt: "2026-08-09T00:00:00.000Z",
        },
        approvedBy: "Synthetic operator",
        reason: "Explicit test approval",
      },
    ]);

    expect(published).toHaveLength(2);
    expect(Object.keys(published[0].item).sort()).toEqual([
      "costCents",
      "description",
      "gstBasis",
      "id",
      "itemNumber",
      "sellPriceCents",
      "updatedAt",
    ]);
    expect(published[0].item).not.toHaveProperty("sku");
    expect(store.listItems().map((item: { id: string }) => item.id)).toEqual([
      "000123",
      "000124",
    ]);
    expect(store.listApprovals()).toHaveLength(2);
    expect(store.listPriceHistory()).toHaveLength(2);
    expect(store.listPriceHistory("000123")[0].approvalId).toBe(
      published[0].approval.id,
    );
  });

  it("validates the complete batch before mutation", () => {
    const { store } = tempStore();
    seedItem(store);
    const before = {
      items: store.listItems(),
      approvals: store.listApprovals(),
      history: store.listPriceHistory(),
    };
    expect(() =>
      store.publishApprovedChanges([
        {
          item: {
            id: "GOOD",
            itemNumber: "GOOD",
            description: "First synthetic item",
            costCents: 10_000,
            sellPriceCents: 13_000,
            gstBasis: "unknown",
          },
          approvedBy: "Synthetic operator",
          reason: "Explicit test approval",
        },
        {
          item: {
            id: "BAD",
            itemNumber: "BAD",
            description: "Below-floor synthetic item",
            costCents: 10_000,
            sellPriceCents: 12_999,
            gstBasis: "unknown",
          },
          approvedBy: "Synthetic operator",
          reason: "Explicit test approval",
        },
      ]),
    ).toThrow(FloorViolationError);
    expect(store.listItems()).toEqual(before.items);
    expect(store.listApprovals()).toEqual(before.approvals);
    expect(store.listPriceHistory()).toEqual(before.history);
  });

  it.each([
    [
      "duplicate catalogue identifiers",
      [
        { id: "DUP", itemNumber: "NUMBER-A" },
        { id: "DUP", itemNumber: "NUMBER-B" },
      ],
    ],
    [
      "duplicate item numbers",
      [
        { id: "ITEM-A", itemNumber: "DUP-NUMBER" },
        { id: "ITEM-B", itemNumber: "DUP-NUMBER" },
      ],
    ],
  ])(
    "rejects %s across a batch before changing any file",
    (_case, identities) => {
      const { dir, store } = tempStore();
      seedItem(store);
      const before = publicationFileSnapshot(dir);
      expect(() =>
        store.publishApprovedChanges(
          identities.map((identity) => ({
            item: {
              ...identity,
              description: "Synthetic duplicate-guard item",
              costCents: 10_000,
              sellPriceCents: 13_000,
              gstBasis: "unknown",
            },
            approvedBy: "Synthetic operator",
            reason: "Synthetic duplicate guard",
          })),
        ),
      ).toThrow(PublicationValidationError);
      expect(publicationFileSnapshot(dir)).toEqual(before);
    },
  );

  it.each([
    ["raw imported row", { rawSupplierRow: { cost: "not-a-real-value" } }],
    ["secret field", { credential: "not-a-real-placeholder" }],
  ])(
    "rejects catalogue %s without persisting any part of it",
    (_case, extra) => {
      const { dir, store } = tempStore();
      const existing = seedItem(store);
      const before = publicationFileSnapshot(dir);
      expect(() => store.putItem({ ...existing, ...extra })).toThrow(
        PublicationValidationError,
      );
      expect(() =>
        store.publishApprovedChanges([
          {
            item: {
              id: "STRICT",
              itemNumber: "STRICT",
              description: "Synthetic strict-schema item",
              costCents: 10_000,
              sellPriceCents: 13_000,
              gstBasis: "unknown",
              ...extra,
            },
            approvedBy: "Synthetic operator",
            reason: "Synthetic strict-schema guard",
          },
        ]),
      ).toThrow(PublicationValidationError);
      expect(publicationFileSnapshot(dir)).toEqual(before);
    },
  );

  it("blocks direct new-item and money mutation through metadata updates", () => {
    const { store } = tempStore();
    const existing = seedItem(store);
    expect(() =>
      store.updateItemMetadata({
        ...existing,
        id: "NEW",
        sku: "NEW",
        itemNumber: "NEW",
      }),
    ).toThrow(PublicationValidationError);
    expect(() =>
      store.updateItemMetadata({
        ...existing,
        itemNumber: "LW4570",
        sellPriceCents: existing.sellPriceCents + 1,
      }),
    ).toThrow(PublicationValidationError);
    expect(store.getItem("LW4570")?.sellPriceCents).toBe(13_000);
  });

  it("recovers the prior files from an interrupted publication journal on restart", () => {
    const { dir, store } = tempStore();
    seedItem(store);
    const fileNames = {
      items: "catalogue-items.json",
      approvals: "approvals.jsonl",
      history: "price-history.jsonl",
    } as const;
    const before = Object.fromEntries(
      Object.entries(fileNames).map(([name, file]) => {
        const path = join(dir, file);
        return [
          name,
          existsSync(path)
            ? { existed: true, content: readFileSync(path, "utf8") }
            : { existed: false, content: "" },
        ];
      }),
    );
    writeFileSync(
      join(dir, ".catalogue-publication-rollback.json"),
      JSON.stringify({ version: 1, before }),
    );
    writeFileSync(join(dir, "catalogue-items.json"), "[]");
    writeFileSync(join(dir, "approvals.jsonl"), '{"partial":true}\n');
    writeFileSync(join(dir, "price-history.jsonl"), '{"partial":true}\n');

    const reopened = createStore(dir);
    expect(reopened.listItems()).toHaveLength(1);
    expect(reopened.listApprovals()).toEqual([]);
    expect(reopened.listPriceHistory()).toEqual([]);
    expect(existsSync(join(dir, ".catalogue-publication-rollback.json"))).toBe(
      false,
    );
  });

  it("validates every recovery snapshot before changing any live file", () => {
    const { dir, store } = tempStore();
    seedItem(store);
    const approval = store.appendApproval({
      itemId: "LW4570",
      approvedBy: "Synthetic operator",
      proposedSellCents: 13_000,
    });
    store.appendPriceVersion({
      itemId: "LW4570",
      costCents: 10_000,
      sellPriceCents: 13_000,
      approvalId: approval.id,
    });
    const fileNames = {
      items: "catalogue-items.json",
      approvals: "approvals.jsonl",
      history: "price-history.jsonl",
    } as const;
    const liveBytes: Record<keyof typeof fileNames, string> = {
      items: readFileSync(join(dir, fileNames.items)).toString("base64"),
      approvals: readFileSync(join(dir, fileNames.approvals)).toString(
        "base64",
      ),
      history: readFileSync(join(dir, fileNames.history)).toString("base64"),
    };
    const before = {
      items: {
        existed: true,
        content: readFileSync(join(dir, fileNames.items), "utf8"),
      },
      approvals: {
        existed: true,
        content: readFileSync(join(dir, fileNames.approvals), "utf8"),
      },
      history: {
        existed: true,
        content: readFileSync(join(dir, fileNames.history), "utf8"),
      },
    };
    const orphanApproval = JSON.parse(before.approvals.content.trim());
    orphanApproval.itemId = "missing-item";
    before.approvals.content = `${JSON.stringify(orphanApproval)}\n`;
    const journalPath = join(dir, ".catalogue-publication-rollback.json");
    writeFileSync(journalPath, JSON.stringify({ version: 1, before }));

    expect(() => createStore(dir)).toThrow(PublicationValidationError);
    for (const name of Object.keys(fileNames) as Array<
      keyof typeof fileNames
    >) {
      expect(readFileSync(join(dir, fileNames[name])).toString("base64")).toBe(
        liveBytes[name],
      );
    }
    expect(existsSync(journalPath)).toBe(true);
  });
});

describe("competitor references are provably inert", () => {
  it("rejects an orphan reference for a missing catalogue item", () => {
    const { store } = tempStore();
    expect(() =>
      store.appendReference({ itemId: "missing", observation: {} }),
    ).toThrow(MissingCatalogueItemError);
  });
  it("attaching a reference leaves the catalogue item byte-identical", () => {
    const { dir, store } = tempStore();
    seedItem(store);
    const itemsPath = join(dir, "catalogue-items.json");
    const before = readFileSync(itemsPath);
    store.appendReference({
      itemId: "LW4570",
      // Deliberately below cost: reference evidence must still change nothing.
      observation: syntheticObservation(),
    });
    const after = readFileSync(itemsPath);
    expect(Buffer.compare(before, after)).toBe(0); // byte-identical
    expect(store.listPriceHistory("LW4570")).toHaveLength(0);
    expect(store.listReferences("LW4570")).toHaveLength(1);
  });

  it("accepts the strict bounded manual-evidence shape used by the shared frontend", () => {
    const { store } = tempStore();
    seedItem(store);
    const stored = store.appendReference({
      itemId: "LW4570",
      observation: syntheticManualObservation(),
    });
    expect(stored.observation).toEqual(syntheticManualObservation());
    expect(store.listPriceHistory()).toEqual([]);
  });

  it.each([
    [
      "unknown imported-row field",
      syntheticObservation({ supplierCostCents: 10_000 }),
    ],
    [
      "secret-like field",
      syntheticObservation({ apiKey: "not-a-real-placeholder" }),
    ],
    [
      "non-HTTPS URL",
      syntheticObservation({
        url: "http://fictionville-security.example.com.au/x",
      }),
    ],
    [
      "credential-bearing URL",
      syntheticObservation({
        url: "https://not-a-real-placeholder@fictionville-security.example.com.au/x",
      }),
    ],
    [
      "source-domain mismatch",
      syntheticObservation({ sourceDomain: "other.example.test" }),
    ],
    ["unsupported currency", syntheticObservation({ currency: "USD" })],
    ["unsupported GST state", syntheticObservation({ gstBasis: "inferred" })],
    ["inconsistent amount", syntheticObservation({ priceAud: "95.01" })],
    ["invalid timestamp", syntheticObservation({ retrievedAt: "not-a-date" })],
    [
      "normalised invalid calendar date",
      syntheticObservation({ retrievedAt: "2026-02-30T00:00:00.000Z" }),
    ],
  ])(
    "rejects %s without creating or changing reference data",
    (_case, observation) => {
      const { dir, store } = tempStore();
      seedItem(store);
      const referencePath = join(dir, "competitor-references.jsonl");
      expect(existsSync(referencePath)).toBe(false);
      expect(() =>
        store.appendReference({ itemId: "LW4570", observation }),
      ).toThrow(PublicationValidationError);
      expect(existsSync(referencePath)).toBe(false);
      expect(store.listReferences()).toEqual([]);
    },
  );

  it("rejects unknown reference envelope fields without mutating the store", () => {
    const { dir, store } = tempStore();
    seedItem(store);
    expect(() =>
      store.appendReference({
        itemId: "LW4570",
        observation: syntheticObservation(),
        privateNotes: "not-a-real-placeholder",
      }),
    ).toThrow(PublicationValidationError);
    expect(existsSync(join(dir, "competitor-references.jsonl"))).toBe(false);
  });

  it("keeps an existing reference file byte-identical after a rejected full-row payload", () => {
    const { dir, store } = tempStore();
    seedItem(store);
    store.appendReference({
      itemId: "LW4570",
      observation: syntheticObservation(),
    });
    const referencePath = join(dir, "competitor-references.jsonl");
    const before = readFileSync(referencePath);
    expect(() =>
      store.appendReference({
        itemId: "LW4570",
        observation: syntheticManualObservation({
          rawSupplierRow: {
            supplierCost: "not-a-real-value",
            credential: "synthetic-placeholder",
          },
        }),
      }),
    ).toThrow(PublicationValidationError);
    expect(Buffer.compare(before, readFileSync(referencePath))).toBe(0);
  });

  it.each([
    [
      "full imported row",
      syntheticManualObservation({ supplierRow: { cost: "100.00" } }),
    ],
    [
      "secret field",
      syntheticManualObservation({ accessToken: "not-a-real-placeholder" }),
    ],
    [
      "credential URL",
      syntheticManualObservation({ url: "https://user:pass@example.test/x" }),
    ],
    ["HTTP URL", syntheticManualObservation({ url: "http://example.test/x" })],
    ["unsupported currency", syntheticManualObservation({ currency: "USD" })],
    ["invalid GST", syntheticManualObservation({ gstBasis: "inferred" })],
    [
      "invalid stock state",
      syntheticManualObservation({ stockStatus: "back-order" }),
    ],
    [
      "invalid condition",
      syntheticManualObservation({ condition: "refurbished" }),
    ],
    [
      "invalid review state",
      syntheticManualObservation({ reviewState: "pending" }),
    ],
    [
      "invalid confidence",
      syntheticManualObservation({ matchConfidence: 1.01 }),
    ],
    [
      "oversized evidence text",
      syntheticManualObservation({ sourceName: "x".repeat(257) }),
    ],
    ["invalid money", syntheticManualObservation({ price: "95.001" })],
  ])(
    "rejects manual evidence with %s without changing the store",
    (_case, observation) => {
      const { dir, store } = tempStore();
      seedItem(store);
      const referencePath = join(dir, "competitor-references.jsonl");
      expect(() =>
        store.appendReference({ itemId: "LW4570", observation }),
      ).toThrow(PublicationValidationError);
      expect(existsSync(referencePath)).toBe(false);
      expect(store.listReferences()).toEqual([]);
    },
  );
});

describe("price history persists across an application restart", () => {
  it('writes with one store instance, "restarts" by creating a new instance on the same directory, and reads back', () => {
    const { dir, store } = tempStore();
    seedItem(store);
    const approval = store.appendApproval({
      itemId: "LW4570",
      approvedBy: "Test operator",
      proposedSellCents: 13000,
    });
    store.appendPriceVersion({
      itemId: "LW4570",
      costCents: 10000,
      sellPriceCents: 13000,
      approvalId: approval.id,
    });

    // Restart: a brand-new store instance with no shared in-memory state.
    const reopened = createStore(dir);
    const history = reopened.listPriceHistory("LW4570");
    expect(history).toHaveLength(1);
    expect(history[0].sellPrice).toBe("130.00");
    expect(history[0].approvalId).toBe(approval.id);
    expect(reopened.getItem("LW4570")?.sellPriceCents).toBe(13000);
    expect(reopened.listApprovals()).toHaveLength(1);
  });

  it("history is append-only: the store exposes no update or delete for versions", () => {
    const { store } = tempStore();
    const historyMethods = Object.keys(store).filter((k) =>
      /history|version/i.test(k),
    );
    expect(historyMethods.sort()).toEqual([
      "appendPriceVersion",
      "listPriceHistory",
    ]);
  });
});

describe("stored Node records are validated before read or publication", () => {
  it("rejects duplicate, orphan and unknown stored records without rewriting them", () => {
    const { dir, store } = tempStore();
    seedItem(store);
    const approval = store.appendApproval({
      itemId: "LW4570",
      approvedBy: "Synthetic operator",
      proposedSellCents: 13_000,
    });
    store.appendPriceVersion({
      itemId: "LW4570",
      costCents: 10_000,
      sellPriceCents: 13_000,
      approvalId: approval.id,
    });
    store.appendReference({
      itemId: "LW4570",
      observation: syntheticObservation(),
    });
    const source = {
      id: "synthetic-source",
      name: "Synthetic source",
      accessMethod: "manual-entry",
      automatedAccessNote: "No automated access",
      enabled: true,
    };
    store.putSources([source]);

    const paths = {
      approvals: join(dir, "approvals.jsonl"),
      history: join(dir, "price-history.jsonl"),
      references: join(dir, "competitor-references.jsonl"),
      sources: join(dir, "source-registry.json"),
    };
    const originals = {
      approvals: readFileSync(paths.approvals, "utf8"),
      history: readFileSync(paths.history, "utf8"),
      references: readFileSync(paths.references, "utf8"),
      sources: readFileSync(paths.sources, "utf8"),
    };
    const originalByPath = new Map(
      Object.keys(paths).map((name) => [
        paths[name as keyof typeof paths],
        originals[name as keyof typeof originals],
      ]),
    );
    const approvalRecord = JSON.parse(originals.approvals.trim());
    const historyRecord = JSON.parse(originals.history.trim());
    const referenceRecord = JSON.parse(originals.references.trim());
    const cases = [
      {
        path: paths.approvals,
        content: `${originals.approvals}${originals.approvals}`,
        read: () => store.listApprovals(),
      },
      {
        path: paths.approvals,
        content: `${JSON.stringify({ ...approvalRecord, itemId: "missing-item" })}\n`,
        read: () => store.listApprovals(),
      },
      {
        path: paths.approvals,
        content: `${JSON.stringify({ ...approvalRecord, credential: "not-a-real-placeholder" })}\n`,
        read: () => store.listApprovals(),
      },
      {
        path: paths.history,
        content: `${originals.history}${originals.history}`,
        read: () => store.listPriceHistory(),
      },
      {
        path: paths.history,
        content: `${JSON.stringify({ ...historyRecord, approvalId: "missing-approval" })}\n`,
        read: () => store.listPriceHistory(),
      },
      {
        path: paths.references,
        content: `${originals.references}${originals.references}`,
        read: () => store.listReferences(),
      },
      {
        path: paths.references,
        content: `${JSON.stringify({ ...referenceRecord, itemId: "missing-item" })}\n`,
        read: () => store.listReferences(),
      },
      {
        path: paths.sources,
        content: `${JSON.stringify([source, source])}\n`,
        read: () => store.getSources(),
      },
    ];

    for (const testCase of cases) {
      writeFileSync(testCase.path, testCase.content);
      const corruptedBytes = readFileSync(testCase.path).toString("base64");
      expect(testCase.read).toThrow(PublicationValidationError);
      expect(readFileSync(testCase.path).toString("base64")).toBe(
        corruptedBytes,
      );
      const original = originalByPath.get(testCase.path);
      if (original === undefined)
        throw new Error("Test path has no original snapshot.");
      writeFileSync(testCase.path, original);
    }
  });

  it("refuses publication before mutation when stored approvals are corrupt", () => {
    const { dir, store } = tempStore();
    seedItem(store);
    const approvalsPath = join(dir, "approvals.jsonl");
    writeFileSync(
      approvalsPath,
      `${JSON.stringify({
        id: "orphan-approval",
        itemId: "missing-item",
        approvedBy: "Synthetic operator",
        proposedSellCents: 13_000,
        reason: "",
        approvedAt: "2026-08-09T00:00:00.000Z",
      })}\n`,
    );
    const before = publicationFileSnapshot(dir);
    expect(() =>
      store.publishApprovedChanges([
        {
          item: {
            id: "SAFE",
            itemNumber: "SAFE",
            description: "Synthetic item",
            costCents: 10_000,
            sellPriceCents: 13_000,
            gstBasis: "unknown",
          },
          approvedBy: "Synthetic operator",
          reason: "Synthetic publication",
        },
      ]),
    ).toThrow(PublicationValidationError);
    expect(publicationFileSnapshot(dir)).toEqual(before);
    expect(existsSync(join(dir, ".catalogue-publication-rollback.json"))).toBe(
      false,
    );
  });
});

describe("source registry validation and atomic replacement", () => {
  const source = (id: string) => ({
    id,
    name: `Synthetic source ${id}`,
    accessMethod: "manual-entry",
    automatedAccessNote: "Entered manually in a synthetic test.",
    enabled: true,
  });

  it("validates, atomically persists and reloads a bounded unique registry", () => {
    const { dir, store } = tempStore();
    expect(store.putSources([source("one"), source("two")])).toEqual([
      source("one"),
      source("two"),
    ]);
    expect(createStore(dir).getSources()).toEqual([
      source("one"),
      source("two"),
    ]);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it.each([
    ["non-array", { arbitrary: true }],
    ["duplicate identifiers", [source("same"), source("same")]],
    [
      "unsupported access method",
      [{ ...source("bad-method"), accessMethod: "scrape" }],
    ],
    [
      "non-boolean enabled state",
      [{ ...source("bad-enabled"), enabled: "yes" }],
    ],
    [
      "unexpected fields",
      [{ ...source("extra"), credential: "not-a-real-placeholder" }],
    ],
    ["control characters", [{ ...source("control"), name: "bad\u0000name" }]],
    [
      "too many records",
      Array.from({ length: 1_001 }, (_, index) => source(`s-${index}`)),
    ],
  ])(
    "rejects %s without changing the live source registry",
    (_case, invalid) => {
      const { dir, store } = tempStore();
      store.putSources([source("existing")]);
      const registryPath = join(dir, "source-registry.json");
      const before = readFileSync(registryPath);
      expect(() => store.putSources(invalid)).toThrow(
        PublicationValidationError,
      );
      expect(Buffer.compare(before, readFileSync(registryPath))).toBe(0);
      expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
        [],
      );
    },
  );

  it("cleans its task-created temporary file when atomic rename fails", () => {
    const { dir, store } = tempStore();
    mkdirSync(join(dir, "source-registry.json"));
    expect(() => store.putSources([source("one")])).toThrow();
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
    expect(existsSync(join(dir, "source-registry.json"))).toBe(true);
  });

  it("maps invalid source-registry requests to a validation response", () => {
    const sourceText = readFileSync("server/index.mjs", "utf8");
    expect(sourceText).toContain(
      'if (req.method === "PUT" && url.pathname === "/api/sources")',
    );
    expect(sourceText).toContain("error instanceof PublicationValidationError");
    expect(sourceText).toContain("sendJson(res, 422");
  });
});
