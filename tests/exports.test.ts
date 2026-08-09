// @vitest-environment node
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { runComparison } from "../src/core/compare";
import { extractS8Records, extractSupplierRecords } from "../src/core/records";
import { approveRows, excludeRows, EMPTY_REVIEW } from "../src/core/review";
import { buildAllOutputs } from "../src/io/exportWorkbooks";
import { parseFile } from "../src/io/parse";
import {
  DEMO_SERVICEM8_CSV,
  DEMO_SUPPLIER_CSV,
  DEMO_ALIAS,
} from "../src/demo/fixtures";

const SUPPLIER_MAPPING = {
  supplierCode: 0,
  supplierDescription: 1,
  supplierCost: 2,
};
const S8_MAPPING = {
  itemNumber: 0,
  itemDescription: 1,
  existingCost: 2,
  existingSellPrice: 3,
};

async function demoScenario() {
  const supplierTable = await parseFile(
    new File([DEMO_SUPPLIER_CSV], "DEMO-supplier.csv"),
  );
  const s8Table = await parseFile(
    new File([DEMO_SERVICEM8_CSV], "DEMO-s8.csv"),
  );
  const comparison = runComparison(
    extractSupplierRecords(supplierTable, SUPPLIER_MAPPING),
    extractS8Records(s8Table, S8_MAPPING),
    new Map([[DEMO_ALIAS.supplierCode, DEMO_ALIAS.itemNumber]]),
    "30",
  );
  return { supplierTable, s8Table, comparison };
}

async function readWorkbook(blob: Blob): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await blob.arrayBuffer());
  return wb;
}

function sheetRows(ws: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  ws.eachRow((row) => {
    const cells: string[] = [];
    for (let c = 1; c <= row.cellCount; c += 1) cells.push(row.getCell(c).text);
    rows.push(cells);
  });
  return rows;
}

describe("demo comparison end-to-end statuses", () => {
  it("assigns every expected demo status", async () => {
    const { comparison } = await demoScenario();
    const statusOf = (code: string) =>
      comparison.rows.find(
        (r) =>
          r.supplier?.code === code ||
          (r.supplier === null && r.s8?.itemNumber === code),
      )?.status;

    expect(statusOf("FIC-001")).toBe("unchanged");
    expect(statusOf("FIC-002")).toBe("price-changed"); // increase
    expect(statusOf("FIC-003")).toBe("price-changed"); // decrease
    expect(statusOf("FIC-004")).toBe("new-item");
    expect(statusOf("FIC-900")).toBe("missing-from-supplier");
    expect(statusOf("FIC-006")).toBe("ambiguous"); // description twin of FIC-060
    expect(statusOf("FIC-007")).toBe("invalid"); // missing cost
    expect(statusOf("FIC-008")).toBe("invalid"); // invalid currency
    expect(statusOf("00123")).toBe("price-changed"); // leading zeroes preserved
    expect(statusOf("FIC-010")).toBe("new-item"); // formula-like description, flagged
    expect(statusOf("ALIAS-11")).toBe("price-changed"); // via approved alias
    expect(statusOf("FIC-012")).toBe("price-changed");

    const dupRows = comparison.rows.filter(
      (r) => r.supplier?.code === "FIC-005",
    );
    expect(dupRows).toHaveLength(2);
    for (const r of dupRows) expect(r.status).toBe("ambiguous");

    const alias = comparison.rows.find((r) => r.supplier?.code === "ALIAS-11");
    expect(alias?.matchMethod).toBe("alias");
    const fic010 = comparison.rows.find((r) => r.supplier?.code === "FIC-010");
    expect(
      fic010?.messages.some((m) => m.message.includes("neutralised")),
    ).toBe(true);
  });
});

describe("buildAllOutputs", () => {
  it("generates five outputs whose import workbook contains only approved valid rows", async () => {
    const { supplierTable, s8Table, comparison } = await demoScenario();
    const fic012 = comparison.rows.find((r) => r.supplier?.code === "FIC-012");
    let review = excludeRows(
      EMPTY_REVIEW,
      [fic012!],
      "Fictional exclusion for testing",
    ).state;
    const approvable = comparison.rows.filter(
      (r) =>
        (r.status === "price-changed" || r.status === "new-item") &&
        r.id !== fic012?.id,
    );
    review = approveRows(review, approvable).state;

    const outputs = await buildAllOutputs({
      comparison,
      decisions: review.decisions,
      supplierTable,
      s8Table,
      s8Mapping: S8_MAPPING,
      profileName: "Fictionville Demo",
      profileVersion: 1,
      taxHandling: "Not configured",
      settingsChanges: [],
      startedAt: new Date().toISOString(),
      now: new Date(2026, 7, 3),
    });

    expect(outputs.map((o) => o.kind)).toEqual([
      "import",
      "change-report",
      "exceptions",
      "rollback",
      "audit",
    ]);
    for (const out of outputs) {
      expect(out.filename).toMatch(
        /^20260803-fictionville-demo_[a-z-]+_run-[A-Z0-9]{6}\.(xlsx|txt)$/,
      );
    }
    // All five share the same run id.
    const runIds = new Set(
      outputs.map((o) => /run-([A-Z0-9]{6})/.exec(o.filename)?.[1]),
    );
    expect(runIds.size).toBe(1);

    // --- import workbook ---------------------------------------------------
    const importWb = await readWorkbook(outputs[0]!.blob);
    const importSheet = importWb.getWorksheet("Import")!;
    const rows = sheetRows(importSheet);
    expect(rows[0]).toEqual(s8Table.headers); // template adaptation
    const identifiers = rows.slice(1).map((r) => r[0]);
    // Approved: FIC-002, FIC-003, FIC-004, 00123, FIC-010, ALIAS-11 (excluded: FIC-012)
    expect(identifiers).toContain("FIC-002");
    expect(identifiers).toContain("00123"); // leading zero preserved in output
    expect(identifiers).not.toContain("FIC-012"); // excluded
    expect(identifiers).not.toContain("FIC-001"); // unchanged
    expect(identifiers).not.toContain("FIC-005"); // ambiguous duplicate
    expect(identifiers).not.toContain("FIC-007"); // invalid
    expect(identifiers).not.toContain("FIC-900"); // missing never deleted/added
    expect(rows).toHaveLength(1 + 6);

    // Price change rows carry the recalculated sell price: FIC-002 48.00 -> 62.40.
    const fic002 = rows.find((r) => r[0] === "FIC-002")!;
    expect(fic002[2]).toBe("48");
    expect(fic002[3]).toBe("62.4");
    // Cell number formats are 0.00, so spreadsheets display 48.00 / 62.40.
    expect(importSheet.getColumn(3).numFmt).toBe("0.00");

    // Formula-like description was neutralised with a leading apostrophe.
    const fic010 = rows.find((r) => r[0] === "FIC-010")!;
    expect(fic010[1]!.startsWith("'=")).toBe(true);
    expect(outputs[0]!.sanitizedCells).toBeGreaterThan(0);

    // --- exceptions workbook ----------------------------------------------
    const exceptionsWb = await readWorkbook(outputs[2]!.blob);
    expect(exceptionsWb.worksheets.map((w) => w.name)).toEqual([
      "Ambiguous",
      "Invalid",
      "Missing from supplier",
    ]);
    const ambiguous = sheetRows(exceptionsWb.getWorksheet("Ambiguous")!);
    expect(ambiguous.slice(1).some((r) => r[0] === "FIC-005")).toBe(true);
    const missing = sheetRows(
      exceptionsWb.getWorksheet("Missing from supplier")!,
    );
    expect(missing.slice(1).some((r) => r[0] === "FIC-900")).toBe(true);

    // --- rollback workbook -------------------------------------------------
    const rollbackWb = await readWorkbook(outputs[3]!.blob);
    const rollback = sheetRows(rollbackWb.getWorksheet("Rollback")!);
    expect(rollback[0]).toEqual(s8Table.headers);
    expect(rollback).toHaveLength(1 + s8Table.rows.length);
    expect(rollback.slice(1).map((r) => r[0])).toContain("FIC-900");

    // --- change report -----------------------------------------------------
    const changeWb = await readWorkbook(outputs[1]!.blob);
    const allRecords = sheetRows(changeWb.getWorksheet("All records")!);
    expect(allRecords.length).toBe(1 + comparison.rows.length);
    const excludedRow = allRecords.find((r) => r[3] === "FIC-012");
    expect(excludedRow?.[1]).toBe("Excluded");
    expect(excludedRow?.[15]).toBe("Fictional exclusion for testing");

    // --- audit -------------------------------------------------------------
    const auditText = await outputs[4]!.blob.text();
    expect(auditText).toContain("Markup:              30% on supplier cost");
    expect(auditText).toContain(supplierTable.sha256);
    expect(auditText).toContain("Excluded records (1)");
    expect(auditText).toContain("Fictional exclusion for testing");
    expect(auditText).toContain(
      "This report was generated locally by SWL Pricing and Inventory Control.",
    );
    expect(auditText).not.toContain("generated locally in the browser");
  });

  it("neutralises formula-like template headers and rollback metadata", async () => {
    const { supplierTable, s8Table, comparison } = await demoScenario();
    const untrustedTable = {
      ...s8Table,
      fileName: "\tservice-export.xlsx",
      selectedSheet: "\rPrices",
      headers: ["=identifier", "+description", "-cost header", "@sell header"],
    };

    const outputs = await buildAllOutputs({
      comparison,
      decisions: EMPTY_REVIEW.decisions,
      supplierTable,
      s8Table: untrustedTable,
      s8Mapping: S8_MAPPING,
      profileName: "Formula boundary",
      profileVersion: 1,
      taxHandling: "Not configured",
      settingsChanges: [],
      startedAt: new Date().toISOString(),
      now: new Date(2026, 7, 3),
    });

    const importWorkbook = await readWorkbook(outputs[0]!.blob);
    expect(sheetRows(importWorkbook.getWorksheet("Import")!)[0]).toEqual([
      "'=identifier",
      "'+description",
      "'-cost header",
      "'@sell header",
    ]);

    const rollbackWorkbook = await readWorkbook(outputs[3]!.blob);
    expect(sheetRows(rollbackWorkbook.getWorksheet("Rollback")!)[0]).toEqual([
      "'=identifier",
      "'+description",
      "'-cost header",
      "'@sell header",
    ]);
    const aboutRows = sheetRows(rollbackWorkbook.getWorksheet("About")!);
    expect(aboutRows.find((row) => row[0] === "Original file")?.[1]).toBe(
      "'\tservice-export.xlsx",
    );
    const sheetMetadata =
      aboutRows.find((row) => row[0] === "Sheet")?.[1] ?? "";
    expect(sheetMetadata.startsWith("'")).toBe(true);
    expect(sheetMetadata).toContain("Prices");
    expect(outputs[0]!.sanitizedCells).toBeGreaterThanOrEqual(4);
    expect(outputs[3]!.sanitizedCells).toBeGreaterThanOrEqual(6);
  });
});
