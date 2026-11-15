import { describe, expect, it } from "vitest";
import {
  buildSearchFilterSql,
  embeddingToLiteral,
  ISO_639_1_LANGUAGE_NAMES,
} from "../src/sql-search.js";

describe("buildSearchFilterSql", () => {
  it("numbers topK right after the leading params when no paths are given", () => {
    expect(buildSearchFilterSql("d.path", undefined, 7, ["q"])).toEqual({
      pathCondition: undefined,
      topKParam: "$2",
      params: ["q", 7],
    });
    expect(buildSearchFilterSql("d.path", [], 7, ["q"])).toEqual({
      pathCondition: undefined,
      topKParam: "$2",
      params: ["q", 7],
    });
  });

  it("numbers the path params after the leading params and topK last", () => {
    const { pathCondition, topKParam, params } = buildSearchFilterSql(
      "d.path",
      ["/docs/", "/notes"],
      5,
      ["q"],
    );
    expect(pathCondition).toBe(
      "(d.path LIKE $2 ESCAPE '\\' OR (d.path = $3 OR d.path LIKE $4 ESCAPE '\\'))",
    );
    expect(topKParam).toBe("$5");
    expect(params).toEqual(["q", "/docs/%", "/notes", "/notes/%", 5]);
  });

  it("does not modify the leading params", () => {
    const leading = ["q"];
    buildSearchFilterSql("d.path", ["/a"], 1, leading);
    expect(leading).toEqual(["q"]);
  });
});

describe("embeddingToLiteral", () => {
  it("formats an embedding as a SQL array literal", () => {
    expect(embeddingToLiteral(new Float32Array([1, 0.5, -2]))).toBe("[1,0.5,-2]");
    expect(embeddingToLiteral(new Float32Array([]))).toBe("[]");
  });
});

describe("ISO_639_1_LANGUAGE_NAMES", () => {
  it("maps the 15 supported ISO-639-1 codes to language names", () => {
    expect(Object.keys(ISO_639_1_LANGUAGE_NAMES)).toEqual([
      "en",
      "fr",
      "de",
      "es",
      "it",
      "pt",
      "nl",
      "ru",
      "sv",
      "no",
      "da",
      "fi",
      "hu",
      "ro",
      "tr",
    ]);
    expect(ISO_639_1_LANGUAGE_NAMES.en).toBe("english");
    expect(ISO_639_1_LANGUAGE_NAMES.no).toBe("norwegian");
  });
});
