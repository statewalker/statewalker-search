import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertZipUncompressedSize, zipUncompressedSize } from "../src/zip-size.js";

const fixturesDir = resolve(import.meta.dirname, "fixtures");

interface Entry {
  name: string;
  /** Size written in the central directory; the data itself is empty. */
  declaredSize: number;
}

/**
 * Builds a ZIP whose central directory declares the given uncompressed sizes. Sizes at or above
 * 0xFFFFFFFF are written as ZIP64 extra fields.
 */
function buildZip(entries: Entry[], comment = ""): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local);

    const zip64 = e.declaredSize >= 0xffffffff;
    const extra = zip64 ? new Uint8Array(12) : new Uint8Array(0);
    if (zip64) {
      const ev = new DataView(extra.buffer);
      ev.setUint16(0, 0x0001, true);
      ev.setUint16(2, 8, true);
      ev.setBigUint64(4, BigInt(e.declaredSize), true);
    }
    const cd = new Uint8Array(46 + name.length + extra.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(24, zip64 ? 0xffffffff : e.declaredSize, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    cd.set(extra, 46 + name.length);
    central.push(cd);
    offset += local.length;
  }
  const cdOffset = offset;
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const commentBytes = enc.encode(comment);
  const eocd = new Uint8Array(22 + commentBytes.length);
  const v = new DataView(eocd.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  v.setUint16(20, commentBytes.length, true);
  eocd.set(commentBytes, 22);

  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of all) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

describe("zipUncompressedSize", () => {
  it("sums the uncompressed sizes in the central directory", () => {
    const zip = buildZip([
      { name: "a.xml", declaredSize: 1000 },
      { name: "b.xml", declaredSize: 2345 },
    ]);
    expect(zipUncompressedSize(zip)).toBe(3345);
  });

  it("finds the directory behind an archive comment", () => {
    const zip = buildZip([{ name: "a", declaredSize: 7 }], "a comment");
    expect(zipUncompressedSize(zip)).toBe(7);
  });

  it("reads ZIP64 sizes from the extra field", () => {
    const zip = buildZip([{ name: "big", declaredSize: 6 * 1024 ** 3 }]);
    expect(zipUncompressedSize(zip)).toBe(6 * 1024 ** 3);
  });

  it("reads a real DOCX", async () => {
    const bytes = new Uint8Array(await readFile(resolve(fixturesDir, "sample.docx")));
    // Sum of the entry sizes, as Python's zipfile reports them.
    expect(zipUncompressedSize(bytes)).toBe(1206);
  });

  it("reads an archive with bytes prepended (offsets not adjusted)", () => {
    const zip = buildZip([{ name: "a", declaredSize: 42 }]);
    const prefixed = new Uint8Array(zip.length + 100);
    prefixed.set(zip, 100);
    expect(zipUncompressedSize(prefixed)).toBe(42);
  });

  it("throws on bytes that are not a ZIP", () => {
    expect(() => zipUncompressedSize(new TextEncoder().encode("not a zip at all"))).toThrow(
      /not a ZIP/,
    );
  });

  it("throws on a truncated central directory", () => {
    const zip = buildZip([{ name: "a", declaredSize: 7 }]);
    const v = new DataView(zip.buffer);
    // Claim more entries than the directory holds.
    v.setUint16(zip.length - 12, 5, true);
    expect(() => zipUncompressedSize(zip)).toThrow(/central directory/);
  });
});

describe("assertZipUncompressedSize", () => {
  it("passes an archive within the limit", () => {
    const zip = buildZip([{ name: "a", declaredSize: 100 }]);
    expect(() => assertZipUncompressedSize(zip, 100)).not.toThrow();
  });

  it("throws when the declared size exceeds the limit (zip bomb)", () => {
    const zip = buildZip([{ name: "bomb", declaredSize: 10 * 1024 ** 3 }]);
    expect(() => assertZipUncompressedSize(zip, 500 * 1024 * 1024)).toThrow(
      /uncompressed size .* exceeds the limit/,
    );
  });
});
