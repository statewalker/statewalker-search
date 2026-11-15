import type { AnySubIndexBinding, Index } from "@statewalker/indexer-api";
import { describe, expect, it } from "vitest";
import { type NgramIndex, newNgramAccess } from "../src/index.js";

function fakeIndex(...bindings: AnySubIndexBinding[]): Index {
  const map = new Map(bindings.map((b) => [b.name, b]));
  return {
    name: "docs",
    setBinding: (b) => {
      map.set(b.name, b);
    },
    getBinding: (k) => map.get(k),
    getBindings: () => map.values(),
    async *search() {},
    async deleteDocuments() {},
    async flush() {},
    async close() {},
    async deleteIndex() {},
  };
}

const sub = {} as NgramIndex;

describe("newNgramAccess(name)", () => {
  it("get returns an n-gram sub-index registered under the name", () => {
    const index = fakeIndex({ name: "g", type: "ngram", config: {}, index: sub });
    expect(newNgramAccess("g").get(index)).toBe(sub);
    expect(newNgramAccess("g").tryGet(index)).toBe(sub);
  });

  it("get throws and tryGet returns undefined for a missing name", () => {
    expect(() => newNgramAccess("g").get(fakeIndex())).toThrow(/"g"/);
    expect(newNgramAccess("g").tryGet(fakeIndex())).toBeUndefined();
  });

  it("get throws and tryGet returns undefined when the binding is of another type", () => {
    const index = fakeIndex({ name: "g", type: "fulltext", config: {}, index: sub });
    expect(() => newNgramAccess("g").get(index)).toThrow(/"fulltext"/);
    expect(newNgramAccess("g").tryGet(index)).toBeUndefined();
  });
});
