import { describe, expect, it } from "vitest";
import {
  type AnySubIndexBinding,
  type CreateIndexParams,
  type Index,
  newSubIndexAccess,
  type SearchRequest,
  type SearchResult,
} from "../src/index.js";

interface DemoConfig {
  size: number;
}

const DEMO_TYPE = "demo";

const setDemoConfig = (params: CreateIndexParams, name: string, config: DemoConfig): void => {
  if (!params.subIndexes) params.subIndexes = {};
  params.subIndexes[name] = { type: DEMO_TYPE, ...config };
};

const getDemoConfig = (params: CreateIndexParams, name: string): DemoConfig | undefined => {
  const entry = params.subIndexes?.[name];
  if (!entry || entry.type !== DEMO_TYPE) return undefined;
  return { size: entry.size as number };
};

const demo = newSubIndexAccess<{ id: string }, DemoConfig, { q: string }, { score: number }>("d", {
  type: DEMO_TYPE,
  setConfig: setDemoConfig,
  getConfig: getDemoConfig,
});

/** A stub Index holding the given bindings; only `name` and `getBinding` are used. */
function stubIndex(bindings: AnySubIndexBinding[]): Index {
  const byName = new Map(bindings.map((b) => [b.name, b]));
  return { name: "idx", getBinding: (name: string) => byName.get(name) } as unknown as Index;
}

describe("newSubIndexAccess", () => {
  it("is bound to its name", () => {
    expect(demo.name).toBe("d");
  });

  it("get/tryGet return the bound sub-index of the right type", () => {
    const sub = { id: "x" };
    const index = stubIndex([{ name: "d", type: DEMO_TYPE, config: {}, index: sub } as never]);
    expect(demo.get(index)).toBe(sub);
    expect(demo.tryGet(index)).toBe(sub);
  });

  it("get throws and tryGet returns undefined when the name is not registered", () => {
    const index = stubIndex([]);
    expect(() => demo.get(index)).toThrow('No sub-index named "d" is registered on index "idx"');
    expect(demo.tryGet(index)).toBeUndefined();
  });

  it("get throws and tryGet returns undefined when the binding is of another type", () => {
    const index = stubIndex([{ name: "d", type: "other", config: {}, index: {} } as never]);
    expect(() => demo.get(index)).toThrow(
      'Sub-index "d" on index "idx" is of type "other", not "demo"',
    );
    expect(demo.tryGet(index)).toBeUndefined();
  });

  it("round-trips the config through the modality's helpers under its name", () => {
    const params: CreateIndexParams = { name: "idx" } as CreateIndexParams;
    expect(demo.getConfig(params)).toBeUndefined();
    demo.setConfig(params, { size: 3 });
    expect(params.subIndexes?.d).toEqual({ type: DEMO_TYPE, size: 3 });
    expect(demo.getConfig(params)).toEqual({ size: 3 });
  });

  it("round-trips the sub-query and reads the sub-result under its name", () => {
    const request: SearchRequest = { topK: 5 };
    expect(demo.getQuery(request)).toBeUndefined();
    demo.setQuery(request, { q: "hello" });
    expect(request.subQueries).toEqual({ d: { q: "hello" } });
    expect(demo.getQuery(request)).toEqual({ q: "hello" });

    const entry = {
      path: "/a",
      blockId: "b",
      score: 1,
      subResults: { d: { score: 0.5 } },
    } as SearchResult;
    expect(demo.getResult(entry)).toEqual({ score: 0.5 });
  });
});
