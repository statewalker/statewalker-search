import { describe, expect, it } from "vitest";
import { getMimeType } from "../src/mime-utils.js";

describe("getMimeType", () => {
  it("maps known extensions case-insensitively", () => {
    expect(getMimeType("a.PDF")).toBe("application/pdf");
    expect(getMimeType("dir/readme.md")).toBe("text/markdown");
  });

  it("returns undefined for a name without an extension", () => {
    expect(getMimeType("LICENSE")).toBeUndefined();
  });

  it("uses only the file name, not a dot in a directory name", () => {
    expect(getMimeType("notes.md/LICENSE")).toBeUndefined();
    expect(getMimeType("/a.html/b/c")).toBeUndefined();
  });
});
