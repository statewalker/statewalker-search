import type { BlockReference, DocumentPath } from "@statewalker/indexer-api";
import { describe, expect, it } from "vitest";
import { type MemBlockEngine, MemBlockStore, type RankedKey } from "../src/mem-block-store.js";

interface TextBlock extends BlockReference {
  text: string;
}

/**
 * A recording engine: a word → keys map, so tests can see what the store
 * hands the engine and when.
 */
class WordEngine implements MemBlockEngine<TextBlock> {
  readonly calls: string[] = [];
  readonly texts = new Map<string, string>();

  add(key: string, block: TextBlock): void {
    this.calls.push(`add ${key}`);
    this.texts.set(key, block.text);
  }
  remove(key: string): void {
    this.calls.push(`remove ${key}`);
    this.texts.delete(key);
  }
  // Returns every hit: an engine may return more than `limit`, and the store
  // cuts to topK only after path filtering.
  search(query: string, _limit: number): RankedKey[] {
    const hits: RankedKey[] = [];
    for (const [key, text] of this.texts) {
      const words = text.split(/\s+/);
      const count = words.filter((w) => w === query).length;
      if (count > 0) hits.push({ key, score: count });
    }
    return hits.sort((a, b) => b.score - a.score);
  }
  exportState(): Record<string, unknown> {
    return { texts: [...this.texts.entries()] };
  }
  static restore(state: Record<string, unknown>): WordEngine {
    const engine = new WordEngine();
    for (const [k, v] of state.texts as Array<[string, string]>) engine.texts.set(k, v);
    return engine;
  }
}

const p = (s: string) => s as DocumentPath;

function newStore() {
  const engine = new WordEngine();
  const store = new MemBlockStore<TextBlock>({ label: "TestStore", engine });
  return { engine, store };
}

describe("MemBlockStore — blocks keyed by path + blockId", () => {
  it("stores, replaces and enumerates blocks", () => {
    const { engine, store } = newStore();
    store.put([
      { path: p("/a"), blockId: "1", text: "x" },
      { path: p("/a"), blockId: "2", text: "y" },
    ]);
    store.put([{ path: p("/a"), blockId: "1", text: "z" }]);
    expect(store.count()).toBe(2);
    expect([...store.select()].map((b) => b.text)).toEqual(["z", "y"]);
    // The engine sees the old version removed before the new one is added.
    expect(engine.calls).toEqual([
      expect.stringMatching(/^add .*\|1$/),
      expect.stringMatching(/^add .*\|2$/),
      expect.stringMatching(/^remove .*\|1$/),
      expect.stringMatching(/^add .*\|1$/),
    ]);
  });

  it("does not confuse a path ending in the separator with another blockId", () => {
    const { store } = newStore();
    store.put([
      { path: p("/a|b"), blockId: "c", text: "one" },
      { path: p("/a"), blockId: "b|c", text: "two" },
    ]);
    expect(store.count()).toBe(2);
  });
});

describe("MemBlockStore — prefix selection", () => {
  const blocks: TextBlock[] = [
    { path: p("/foo"), blockId: "1", text: "a" },
    { path: p("/foo/bar"), blockId: "1", text: "b" },
    { path: p("/foo/bar"), blockId: "2", text: "c" },
    { path: p("/foobar"), blockId: "1", text: "d" },
  ];

  it("selects on path-component boundaries", () => {
    const { store } = newStore();
    store.put(blocks);
    expect([...store.select(p("/foo"))].map((b) => b.text)).toEqual(["a", "b", "c"]);
    expect(store.count(p("/foo"))).toBe(3);
    expect(store.count(p("/foo/"))).toBe(2);
    expect(store.count()).toBe(4);
  });

  it("lists distinct paths under a prefix", () => {
    const { store } = newStore();
    store.put(blocks);
    expect([...store.paths(p("/foo"))]).toEqual(["/foo", "/foo/bar"]);
    expect([...store.paths()]).toEqual(["/foo", "/foo/bar", "/foobar"]);
  });

  it("deletes by block and by prefix, returning the number removed", async () => {
    const { engine, store } = newStore();
    store.put(blocks);
    expect(await store.delete([{ path: p("/foo/bar"), blockId: "2" }])).toBe(1);
    expect(await store.delete([{ path: p("/foo") }])).toBe(2);
    expect(await store.delete([{ path: p("/nothing") }])).toBe(0);
    expect([...store.select()].map((b) => b.text)).toEqual(["d"]);
    expect(engine.texts.size).toBe(1);
  });

  it("accepts an async iterable of selectors", async () => {
    const { store } = newStore();
    store.put(blocks);
    async function* sels() {
      yield { path: p("/foobar") };
    }
    expect(await store.delete(sels())).toBe(1);
  });
});

describe("MemBlockStore — multi-query fusion", () => {
  it("accumulates scores across queries so blocks matching more queries rank higher", () => {
    const { store } = newStore();
    store.put([
      { path: p("/d/a"), blockId: "a", text: "alpha alpha alpha" },
      { path: p("/d/b"), blockId: "b", text: "alpha beta" },
      { path: p("/d/c"), blockId: "c", text: "gamma" },
    ]);
    const hits = store.search(["alpha", "beta"], 10);
    expect(hits.map((h) => [h.block.blockId, h.score])).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
  });

  it("filters each query by path prefixes before truncating to topK", () => {
    const { store } = newStore();
    store.put([
      { path: p("/x/1"), blockId: "1", text: "w w w" },
      { path: p("/y/2"), blockId: "2", text: "w w" },
      { path: p("/y/3"), blockId: "3", text: "w" },
    ]);
    expect(store.search(["w"], 1, [p("/y")]).map((h) => h.block.blockId)).toEqual(["2"]);
    expect(store.search(["w"], 10, [p("/y"), p("/x")]).map((h) => h.block.blockId)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("returns nothing for no queries", () => {
    const { store } = newStore();
    store.put([{ path: p("/a"), blockId: "1", text: "w" }]);
    expect(store.search([], 10)).toEqual([]);
  });
});

describe("MemBlockStore — dirty tracking", () => {
  it("starts dirty, is clean after serialize and dirty again after a change", () => {
    const { store } = newStore();
    expect(store.isDirty()).toBe(true);
    store.serialize();
    expect(store.isDirty()).toBe(false);
    store.put([{ path: p("/a"), blockId: "1", text: "w" }]);
    expect(store.isDirty()).toBe(true);
  });

  it("skips empty batches without becoming dirty", () => {
    const { engine, store } = newStore();
    store.serialize();
    store.put([]);
    expect(store.isDirty()).toBe(false);
    expect(engine.calls).toEqual([]);
  });

  it("stays clean when a delete removes nothing", async () => {
    const { store } = newStore();
    store.put([{ path: p("/a"), blockId: "1", text: "w" }]);
    store.serialize();
    await store.delete([{ path: p("/b") }]);
    expect(store.isDirty()).toBe(false);
  });

  it("returns the cached serialization while clean, without asking the engine again", () => {
    const { engine, store } = newStore();
    store.put([{ path: p("/a"), blockId: "1", text: "w" }]);
    let exports = 0;
    const original = engine.exportState.bind(engine);
    engine.exportState = () => {
      exports += 1;
      return original();
    };
    const first = store.serialize();
    const second = store.serialize();
    expect(second).toBe(first);
    expect(exports).toBe(1);
  });
});

describe("MemBlockStore — persistence framing", () => {
  it("frames the blocks and the engine state in one versioned JSON document", () => {
    const { store } = newStore();
    store.put([{ path: p("/a"), blockId: "1", text: "w", metadata: { k: 1 } } as TextBlock]);
    const parsed = JSON.parse(store.serialize());
    expect(parsed.version).toBe(3);
    expect(parsed.blocks).toEqual([{ path: "/a", blockId: "1", text: "w", metadata: { k: 1 } }]);
    expect(parsed.texts).toBeDefined();
  });

  it("restores blocks and engine, clean, re-serializing to the same string", () => {
    const { store } = newStore();
    store.put([
      { path: p("/a"), blockId: "1", text: "hello" },
      { path: p("/b"), blockId: "2", text: "world" },
    ]);
    const json = store.serialize();

    const other = new MemBlockStore<TextBlock>({ label: "TestStore", engine: new WordEngine() });
    other.restore(json, (state) => WordEngine.restore(state));
    expect(other.isDirty()).toBe(false);
    expect(other.count()).toBe(2);
    expect(other.search(["world"], 10).map((h) => h.block.blockId)).toEqual(["2"]);
    expect(other.serialize()).toBe(json);
  });

  it("rejects an unknown version, naming the store", () => {
    const { store } = newStore();
    expect(() =>
      store.restore(JSON.stringify({ version: 2, blocks: [] }), WordEngine.restore),
    ).toThrow(/TestStore: unsupported serialised version 2 \(expected 3\)/);
    expect(() => store.restore(JSON.stringify({ blocks: [] }), WordEngine.restore)).toThrow(
      /version/,
    );
  });

  it("clear drops every block from the store and the engine", () => {
    const { engine, store } = newStore();
    store.put([{ path: p("/a"), blockId: "1", text: "w" }]);
    store.serialize();
    store.clear();
    expect(store.count()).toBe(0);
    expect(engine.texts.size).toBe(0);
    expect(store.isDirty()).toBe(true);
  });
});
