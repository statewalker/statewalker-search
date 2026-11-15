import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDocxExtractor, docxExtractor } from "../../src/extractors/docx-extractor.js";

const fixturesDir = resolve(import.meta.dirname, "../fixtures");

describe("docxExtractor", () => {
  it("extracts text from a DOCX file", async () => {
    const bytes = await readFile(resolve(fixturesDir, "sample.docx"));
    const result = await docxExtractor([new Uint8Array(bytes)]);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("Test Document");
    expect(result as string).toContain("test paragraph");
    expect(result as string).toContain("**bold text**");
  });

  it("converts bold formatting to markdown", async () => {
    const bytes = await readFile(resolve(fixturesDir, "sample.docx"));
    const result = (await docxExtractor([new Uint8Array(bytes)])) as string;
    expect(result).toContain("**bold text**");
  });
});

describe("createDocxExtractor limits", () => {
  it("works with the defaults", async () => {
    const bytes = await readFile(resolve(fixturesDir, "sample.docx"));
    const result = (await createDocxExtractor()([new Uint8Array(bytes)])) as string;
    expect(result).toContain("Test Document");
  });

  it("rejects input larger than maxBytes", async () => {
    const bytes = await readFile(resolve(fixturesDir, "sample.docx"));
    await expect(createDocxExtractor({ maxBytes: 100 })([new Uint8Array(bytes)])).rejects.toThrow(
      /exceeds the limit/,
    );
  });

  it("rejects an archive whose uncompressed size exceeds maxUncompressedBytes", async () => {
    const bytes = await readFile(resolve(fixturesDir, "sample.docx"));
    await expect(
      createDocxExtractor({ maxUncompressedBytes: 1000 })([new Uint8Array(bytes)]),
    ).rejects.toThrow(/uncompressed size/);
  });
});
