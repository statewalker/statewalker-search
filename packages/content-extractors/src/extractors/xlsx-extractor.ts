import ExcelJS from "exceljs";
import { collectBytes } from "../collect-bytes.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
  type ZipExtractorLimits,
} from "../limits.js";
import type { ContentExtractor } from "../types.js";
import { assertZipUncompressedSize } from "../zip-size.js";

/**
 * Makes a cell value safe inside a Markdown table row: `|` becomes `\|` so it does not start a
 * new column, and every line break (CR, LF, CRLF) becomes one space so it does not end the row.
 */
export function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, " ");
}

/** Width of the widest row. A loop, not `Math.max(...)`, so large sheets do not overflow the stack. */
export function maxColumnCount(rows: readonly (readonly unknown[])[]): number {
  let max = 0;
  for (const row of rows) {
    if (row.length > max) max = row.length;
  }
  return max;
}

/**
 * Converts Excel spreadsheets into markdown tables so the content
 * is searchable and consumable by text-based pipelines. Each worksheet
 * becomes a separate section with a level-2 heading. Empty sheets are
 * skipped to avoid noise. The input size and the archive's declared
 * uncompressed size are checked before exceljs inflates it.
 */
export function createXlsxExtractor(limits: ZipExtractorLimits = {}): ContentExtractor {
  const { maxBytes = DEFAULT_MAX_BYTES, maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES } =
    limits;
  return async (content) => {
    const bytes = await collectBytes(content, { maxBytes });
    assertZipUncompressedSize(bytes, maxUncompressedBytes);
    const workbook = new ExcelJS.Workbook();
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await workbook.xlsx.load(arrayBuffer as ArrayBuffer);

    const sections: string[] = [];

    workbook.eachSheet((sheet) => {
      const rows: string[][] = [];

      sheet.eachRow((row) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          try {
            const v = cell.value;
            cells.push(v == null ? "" : escapeCell(String(v)));
          } catch {
            cells.push("");
          }
        });
        rows.push(cells);
      });

      if (rows.length === 0) return;

      // Normalize column count to the widest row
      const colCount = maxColumnCount(rows);
      for (const r of rows) {
        while (r.length < colCount) r.push("");
      }

      // First row as headers, rest as data
      const [headers, ...dataRows] = rows;
      if (!headers) return;

      const headerLine = `| ${headers.join(" | ")} |`;
      const separator = `| ${headers.map(() => "---").join(" | ")} |`;
      const bodyLines = dataRows.map((r) => `| ${r.join(" | ")} |`);

      const table = [headerLine, separator, ...bodyLines].join("\n");
      sections.push(`## ${sheet.name}\n\n${table}`);
    });

    return sections.join("\n\n");
  };
}

/** XLSX extractor with the default limits. */
export const xlsxExtractor: ContentExtractor = createXlsxExtractor();
