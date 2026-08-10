// @vitest-environment node
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { parseFile, ParseError } from "../src/io/parse";
import { MAX_COLUMNS, MAX_FILE_BYTES, MAX_ROWS } from "../src/io/limits";

function csvFile(name: string, content: string): File {
  return new File([content], name, { type: "text/csv" });
}

async function xlsxFile(
  name: string,
  build: (wb: ExcelJS.Workbook) => void | Promise<void>,
): Promise<File> {
  const wb = new ExcelJS.Workbook();
  await build(wb);
  const buffer = await wb.xlsx.writeBuffer();
  return new File([buffer], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

describe("CSV parsing", () => {
  it("parses headers and rows, preserving leading zeroes and punctuation", async () => {
    const table = await parseFile(
      csvFile(
        "demo.csv",
        'Code,Name,Cost\n00123,"Fictional, thing",7.25\n=EVIL(),Injected,1.00\n',
      ),
    );
    expect(table.fileType).toBe("csv");
    expect(table.headers).toEqual(["Code", "Name", "Cost"]);
    expect(table.rows).toEqual([
      ["00123", "Fictional, thing", "7.25"],
      ["=EVIL()", "Injected", "1.00"],
    ]);
    expect(table.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pads ragged rows to header width", async () => {
    const table = await parseFile(csvFile("ragged.csv", "A,B,C\n1,2\n"));
    expect(table.rows).toEqual([["1", "2", ""]]);
  });

  it("rejects unsupported extensions with a specific explanation", async () => {
    await expect(parseFile(csvFile("data.xls", "A\n1"))).rejects.toThrowError(
      ParseError,
    );
    await expect(parseFile(csvFile("data.txt", "A\n1"))).rejects.toThrow(
      /not a supported file type/,
    );
  });

  it("rejects empty files and header-only files", async () => {
    await expect(parseFile(csvFile("empty.csv", ""))).rejects.toThrow(/empty/);
    await expect(parseFile(csvFile("headers.csv", "A,B,C\n"))).rejects.toThrow(
      /no data rows/,
    );
  });

  it("rejects oversized files with the documented limit", async () => {
    const big = new File([new Uint8Array(MAX_FILE_BYTES + 1)], "big.csv");
    await expect(parseFile(big)).rejects.toThrow(/too large/);
  });

  it("rejects files with too many columns", async () => {
    const headers = Array.from({ length: 101 }, (_, i) => `C${i}`).join(",");
    await expect(
      parseFile(csvFile("wide.csv", `${headers}\n${headers}\n`)),
    ).rejects.toThrow(/too many columns/);
  });

  it("accepts the documented maximum row and column dimensions", async () => {
    const headers = Array.from({ length: MAX_COLUMNS }, (_, i) => `C${i}`).join(
      ",",
    );
    const row = Array.from({ length: MAX_COLUMNS }, () => "v").join(",");
    const content = `${headers}\n${`${row}\n`.repeat(MAX_ROWS)}`;

    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(
      MAX_FILE_BYTES,
    );
    const table = await parseFile(csvFile("maximum-supported.csv", content));

    expect(table.headers).toHaveLength(MAX_COLUMNS);
    expect(table.rows).toHaveLength(MAX_ROWS);
    expect(table.rows.at(-1)).toHaveLength(MAX_COLUMNS);
  }, 60_000);
});

describe("XLSX parsing", () => {
  it("parses a workbook and lists all sheets", async () => {
    const file = await xlsxFile("book.xlsx", (wb) => {
      const ws = wb.addWorksheet("Prices");
      ws.addRow(["Code", "Name", "Cost"]);
      ws.addRow(["00123", "Fictional Bolt", 7.25]);
      wb.addWorksheet("Notes").addRow(["ignore"]);
    });
    const table = await parseFile(file);
    expect(table.sheetNames).toEqual(["Prices", "Notes"]);
    expect(table.selectedSheet).toBe("Prices");
    expect(table.headers).toEqual(["Code", "Name", "Cost"]);
    expect(table.rows[0]).toEqual(["00123", "Fictional Bolt", "7.25"]);
  });

  it("honours a preferred sheet selection", async () => {
    const file = await xlsxFile("book.xlsx", (wb) => {
      wb.addWorksheet("First").addRows([["H1"], ["a"]]);
      wb.addWorksheet("Second").addRows([["H2"], ["b"]]);
    });
    const table = await parseFile(file, "Second");
    expect(table.selectedSheet).toBe("Second");
    expect(table.headers).toEqual(["H2"]);
  });

  it("uses formula results without executing anything, and warns", async () => {
    const file = await xlsxFile("formulas.xlsx", (wb) => {
      const ws = wb.addWorksheet("S");
      ws.addRow(["Code", "Cost"]);
      ws.addRow(["A-1", { formula: "1+1", result: 2 }]);
    });
    const table = await parseFile(file);
    expect(table.rows[0]).toEqual(["A-1", "2"]);
    expect(table.warnings.some((w) => w.includes("formula cells"))).toBe(true);
  });

  it("handles rich text and unexpected cell types as plain text", async () => {
    const file = await xlsxFile("rich.xlsx", (wb) => {
      const ws = wb.addWorksheet("S");
      ws.addRow(["Code", "Name"]);
      ws.getCell("A2").value = {
        richText: [{ text: "AB-" }, { text: "99", font: { bold: true } }],
      };
      ws.getCell("B2").value = true as unknown as ExcelJS.CellValue;
    });
    const table = await parseFile(file);
    expect(table.rows[0]?.[0]).toBe("AB-99");
    expect(table.rows[0]?.[1]).toBe("true");
  });

  it("rejects corrupted xlsx content", async () => {
    const junk = new File(
      [new TextEncoder().encode("not really a zip")],
      "fake.xlsx",
    );
    await expect(parseFile(junk)).rejects.toThrow(
      /could not be read as an XLSX workbook/,
    );
  });
});
