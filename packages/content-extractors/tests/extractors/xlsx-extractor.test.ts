import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  createXlsxExtractor,
  escapeCell,
  maxColumnCount,
  xlsxExtractor,
} from "../../src/extractors/xlsx-extractor.js";

async function workbook(sheets: Record<string, unknown[][]>): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

describe("xlsxExtractor", () => {
  it("turns each sheet into a Markdown table with the first row as header", async () => {
    const bytes = await workbook({
      People: [
        ["Name", "Age"],
        ["Ann", 31],
        ["Bob", 42],
      ],
    });
    const result = await xlsxExtractor([bytes]);
    expect(result).toBe(
      ["## People", "", "| Name | Age |", "| --- | --- |", "| Ann | 31 |", "| Bob | 42 |"].join(
        "\n",
      ),
    );
  });

  it("pads short rows and skips empty sheets", async () => {
    const bytes = await workbook({
      Empty: [],
      Data: [["a", "b", "c"], ["x"]],
    });
    const result = await xlsxExtractor([bytes]);
    expect(result).toBe(
      ["## Data", "", "| a | b | c |", "| --- | --- | --- |", "| x |  |  |"].join("\n"),
    );
  });

  it("escapes pipes and replaces newlines so rows stay intact", async () => {
    const bytes = await workbook({
      S: [
        ["h1", "h2"],
        ["a|b", "line1\nline2\r\nline3\rline4"],
      ],
    });
    const result = (await xlsxExtractor([bytes])) as string;
    const lines = result.split("\n");
    expect(lines).toEqual([
      "## S",
      "",
      "| h1 | h2 |",
      "| --- | --- |",
      "| a\\|b | line1 line2 line3 line4 |",
    ]);
  });

  it("rejects input larger than maxBytes", async () => {
    const bytes = await workbook({ S: [["a"]] });
    await expect(createXlsxExtractor({ maxBytes: 10 })([bytes])).rejects.toThrow(/exceeds/);
  });

  it("rejects an archive whose uncompressed size exceeds maxUncompressedBytes", async () => {
    const bytes = await workbook({ S: [["a"]] });
    await expect(createXlsxExtractor({ maxUncompressedBytes: 100 })([bytes])).rejects.toThrow(
      /uncompressed size/,
    );
  });
});

describe("escapeCell", () => {
  it("escapes | and flattens CR/LF to a space", () => {
    expect(escapeCell("a|b|c")).toBe("a\\|b\\|c");
    expect(escapeCell("x\r\ny\nz\rw")).toBe("x y z w");
  });
});

describe("maxColumnCount", () => {
  it("returns the widest row", () => {
    expect(maxColumnCount([["a"], ["a", "b", "c"], []])).toBe(3);
    expect(maxColumnCount([])).toBe(0);
  });

  it("does not overflow the stack on a large sheet", () => {
    const rows: string[][] = Array.from({ length: 500_000 }, () => ["x"]);
    expect(maxColumnCount(rows)).toBe(1);
  });
});
