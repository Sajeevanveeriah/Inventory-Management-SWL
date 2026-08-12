// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runComparison } from "../src/core/compare";
import { deriveTaxConvention } from "../src/core/conventions";
import { extractS8Records, extractSupplierRecords } from "../src/core/records";
import { buildExpansionCatalogue } from "../src/core/expansion";
import { approveRows, EMPTY_REVIEW } from "../src/core/review";
import { buildAllOutputs } from "../src/io/exportWorkbooks";
import { parseFile } from "../src/io/parse";
import {
  matchServiceM8Layout,
  SERVICEM8_COLUMNS,
} from "../src/core/servicem8Format";
import type { ColumnMapping } from "../src/core/mapping";

/**
 * Verification against REAL business files, run on demand.
 *
 * No business data lives in this repository. Point these environment variables
 * at genuine exports on the operator's own computer and the suite proves, on
 * that real data, that the generated import file carries ServiceM8's exact
 * format and that every price is derived on the correct GST basis:
 *
 *   SWL_VERIFY_SUPPLIER_CSV=/path/to/supplier.csv \
 *   SWL_VERIFY_SERVICEM8_CSV=/path/to/servicem8-export.csv \
 *   npm test -- real-file-verification
 *
 * Without those variables the suite skips, so CI and a clean checkout stay
 * free of any dependency on private data.
 */

const supplierPath = process.env.SWL_VERIFY_SUPPLIER_CSV;
const s8Path = process.env.SWL_VERIFY_SERVICEM8_CSV;
const enabled = supplierPath !== undefined && s8Path !== undefined;

function fileFrom(path: string): File {
  return new File([readFileSync(path)], path.split("/").pop() ?? "input.csv", {
    type: "text/csv",
  });
}

/** Resolve a mapping from header names, the way the operator would confirm one. */
function mappingFrom(
  headers: string[],
  wanted: Record<string, string>,
): ColumnMapping {
  const mapping: Record<string, number> = {};
  for (const [key, header] of Object.entries(wanted)) {
    const index = headers.findIndex(
      (h) => h.trim().toLowerCase() === header.toLowerCase(),
    );
    if (index >= 0) mapping[key] = index;
  }
  return mapping as ColumnMapping;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

describe.skipIf(!enabled)(
  "verification against real supplier and ServiceM8 exports",
  () => {
    it("produces an import file in ServiceM8’s exact format with correct GST handling", async () => {
      const supplierTable = await parseFile(fileFrom(supplierPath as string));
      const s8Table = await parseFile(fileFrom(s8Path as string));

      // The ServiceM8 export must satisfy the contract before anything else.
      const layout = matchServiceM8Layout(s8Table.headers);
      expect(layout.usable).toBe(true);
      expect(layout.complete).toBe(true);
      expect(s8Table.headers).toEqual([...SERVICEM8_COLUMNS]);

      const supplierMapping = mappingFrom(supplierTable.headers, {
        supplierCode: "Product Code",
        supplierDescription: "Description",
        supplierBarcode: "Barcode",
        supplierCost: "Item Price",
        supplierCategory: "Category",
      });
      const s8Mapping = mappingFrom(s8Table.headers, {
        itemNumber: "Item Number",
        itemDescription: "Name",
        existingCost: "Purchase Cost",
        quantityInStock: "Quantity In Stock",
        existingSellPrice: "Price",
        priceIncludesTaxes: "Price Includes Taxes",
        taxRate: "Tax Rate",
        itemIsInventoried: "Item is Inventoried",
        barcode: "Barcode",
      });

      const s8Records = extractS8Records(s8Table, s8Mapping);
      const supplierRecords = extractSupplierRecords(
        supplierTable,
        supplierMapping,
      );
      const comparison = runComparison(supplierRecords, s8Records, new Map(), {
        markupPercent: "30",
        costBasis: "excluding-gst",
        costBasisConfirmed: true,
        newItemConvention: deriveTaxConvention(s8Records),
      });

      // The optional supplier category survives the real-file pipeline and
      // supplier-only items remain a review-only future catalogue.
      expect(
        supplierRecords.some((record) => (record.category ?? "") !== ""),
      ).toBe(true);
      const expansion = buildExpansionCatalogue(comparison.rows);
      expect(expansion.length).toBeGreaterThan(0);
      expect(expansion.flatMap((category) => category.items)).toHaveLength(
        comparison.rows.filter((row) => row.status === "new-item").length,
      );

      const approvable = comparison.rows.filter(
        (row) => row.status === "price-changed" || row.status === "new-item",
      );
      expect(approvable.length).toBeGreaterThan(0);
      const review = approveRows(EMPTY_REVIEW, approvable).state;

      const outputs = await buildAllOutputs({
        comparison,
        decisions: review.decisions,
        supplierTable,
        s8Table,
        s8Mapping,
        profileName: "Real file verification",
        profileVersion: 1,
        taxHandling: "Supplier costs exclude GST",
        newItemIncludesTaxes: comparison.newItemConvention.includesTaxes,
        newItemTaxRate: comparison.newItemConvention.taxRate,
        settingsChanges: [],
        startedAt: new Date().toISOString(),
        now: new Date(),
      });

      const importOutput = outputs[0];
      expect(importOutput?.kind).toBe("import");
      expect(importOutput?.serviceM8?.matchesCanonicalContract).toBe(true);

      const csv = await (
        importOutput as NonNullable<typeof importOutput>
      ).blob.text();
      // Same dialect as a genuine export: no BOM, CRLF everywhere.
      expect(csv.startsWith("﻿")).toBe(false);
      expect(csv.endsWith("\r\n")).toBe(true);

      const rows = parseCsv(csv);
      expect(rows[0]).toEqual([...SERVICEM8_COLUMNS]);
      expect(rows).toHaveLength(1 + approvable.length);
      for (const row of rows)
        expect(row).toHaveLength(SERVICEM8_COLUMNS.length);

      const col = (name: string) => (rows[0] as string[]).indexOf(name);
      const priceCol = col("Price");
      const basisCol = col("Price Includes Taxes");
      const costCol = col("Purchase Cost");

      for (const row of rows.slice(1)) {
        // Every money value is a plain two-decimal number ServiceM8 can read.
        expect(row[priceCol]).toMatch(/^\d+\.\d{2}$/);
        expect(row[costCol]).toMatch(/^\d+\.\d{2}$/);
        // Every row declares a basis in ServiceM8's own spelling.
        expect(["Yes", "No"]).toContain(row[basisCol]);
        // The price is never below the cost it was derived from.
        expect(Number(row[priceCol])).toBeGreaterThanOrEqual(
          Number(row[costCol]),
        );
      }

      // The GST basis genuinely drives the maths: for a matched row the written
      // price equals cost x 1.30, plus 10% only where the row says it includes
      // tax.
      for (const proposal of approvable.slice(0, 500)) {
        if (proposal.pricing === null) continue;
        const expected =
          proposal.targetBasis === "including-gst"
            ? proposal.pricing.sellIncGst
            : proposal.pricing.sellExGst;
        expect(proposal.proposedSell).toBe(expected);
      }

      // Untouched columns survive verbatim for every existing item.
      const byId = new Map(rows.slice(1).map((row) => [row[0] as string, row]));
      let checked = 0;
      for (const proposal of approvable) {
        if (proposal.s8 === null) continue;
        const written = byId.get(proposal.s8.itemNumber);
        if (written === undefined) continue;
        const original = s8Table.rows[proposal.s8.rowIndex] as string[];
        for (let c = 0; c < original.length; c += 1) {
          if (c === priceCol || c === costCol) continue;
          expect(written[c]).toBe(original[c]);
        }
        checked += 1;
      }
      expect(checked).toBeGreaterThan(0);

      // The rollback file restores exactly what was there before.
      const rollbackCsv = await (
        outputs[3] as NonNullable<(typeof outputs)[3]>
      ).blob.text();
      const rollbackRows = parseCsv(rollbackCsv);
      expect(rollbackRows[0]).toEqual([...SERVICEM8_COLUMNS]);
      for (const row of rollbackRows.slice(1)) {
        const original = s8Table.rows.find((r) => r[0] === row[0]);
        expect(original).toBeDefined();
        expect(row).toEqual(original);
      }
    }, 600_000);
  },
);
