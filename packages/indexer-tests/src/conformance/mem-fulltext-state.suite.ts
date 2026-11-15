// =============================================================================
// In-memory full-text state suite — dirty tracking, empty batches and the
// persistence round-trip of the in-memory full-text sub-indexes (FlexSearch,
// MiniSearch). These are the behaviours that once drifted between the two
// backends (statewalker/statewalker-search#46); every in-memory full-text
// sub-index runs the same suite so they cannot drift again.
// =============================================================================

import type { PersistableSearchIndex, PersistenceEntry } from "@statewalker/indexer-api";
import type {
  FullTextBlock,
  FullTextIndex,
  FulltextQuery,
  FulltextResult,
} from "@statewalker/indexer-fulltext";
import { describe, expect, it } from "vitest";
import { collect } from "./test-utils.js";

/** An in-memory full-text sub-index that persists and reports whether it changed. */
export type MemFullTextStateIndex = FullTextIndex &
  PersistableSearchIndex<FullTextBlock, FulltextQuery, FulltextResult> & {
    /** `true` when the state changed since the last serialise or load. */
    isDirty(): boolean;
  };

export interface MemFullTextStateSuiteOptions {
  /** Create a fresh, empty sub-index. */
  create: () => MemFullTextStateIndex;
}

interface MaterialisedEntry {
  name: string;
  bytes: Uint8Array;
}

async function materialise(index: MemFullTextStateIndex): Promise<MaterialisedEntry[]> {
  const out: MaterialisedEntry[] = [];
  for await (const entry of index.serialise()) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry.content) chunks.push(chunk);
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    out.push({ name: entry.name, bytes });
  }
  return out;
}

function toEntries(entries: MaterialisedEntry[]): PersistenceEntry[] {
  return entries.map(({ name, bytes }) => ({
    name,
    content: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  }));
}

/** Comparable form of serialised entries: each name with its bytes. */
function decode(entries: MaterialisedEntry[]): Array<[string, number[]]> {
  return entries.map((e) => [e.name, Array.from(e.bytes)]);
}

const blockA: FullTextBlock = { path: "/docs/a", blockId: "a1", content: "alpha beta" };
const blockB: FullTextBlock = { path: "/docs/b", blockId: "b1", content: "gamma delta" };

export function runMemFullTextStateSuite(name: string, options: MemFullTextStateSuiteOptions) {
  const { create } = options;

  /** A sub-index holding `blockA`, serialised once so it starts clean. */
  async function clean(): Promise<MemFullTextStateIndex> {
    const index = create();
    await index.addDocument([blockA]);
    await materialise(index);
    expect(index.isDirty()).toBe(false);
    return index;
  }

  describe(`${name} — in-memory full-text state`, () => {
    it("starts dirty and becomes clean after serialise", async () => {
      const index = create();
      expect(index.isDirty()).toBe(true);
      await materialise(index);
      expect(index.isDirty()).toBe(false);
    });

    it("an empty addDocument batch leaves a clean index clean", async () => {
      const index = await clean();
      await index.addDocument([]);
      expect(index.isDirty()).toBe(false);
    });

    it("empty batches in addDocuments leave a clean index clean", async () => {
      const index = await clean();
      await index.addDocuments([[], []]);
      expect(index.isDirty()).toBe(false);
    });

    it("adding a block makes the index dirty", async () => {
      const index = await clean();
      await index.addDocument([blockB]);
      expect(index.isDirty()).toBe(true);
    });

    it("replacing a block makes the index dirty", async () => {
      const index = await clean();
      await index.addDocument([{ ...blockA, content: "replaced" }]);
      expect(index.isDirty()).toBe(true);
    });

    it("deleting nothing leaves a clean index clean", async () => {
      const index = await clean();
      await index.deleteDocuments([{ path: "/missing" }, { path: "/docs/a", blockId: "nope" }]);
      expect(index.isDirty()).toBe(false);
    });

    it("deleting a block makes the index dirty", async () => {
      const index = await clean();
      await index.deleteDocuments([{ path: "/docs/a", blockId: "a1" }]);
      expect(index.isDirty()).toBe(true);
    });

    it("deleting by prefix makes the index dirty", async () => {
      const index = await clean();
      await index.deleteDocuments([{ path: "/docs" }]);
      expect(index.isDirty()).toBe(true);
      expect(await index.getSize()).toBe(0);
    });

    it("serialising an unchanged index twice yields identical entries", async () => {
      const index = create();
      await index.addDocument([blockA, { ...blockA, blockId: "a2", content: "epsilon" }]);
      const first = decode(await materialise(index));
      const second = decode(await materialise(index));
      expect(second).toEqual(first);
    });

    it("loadFrom restores the blocks, leaves the index clean and re-serialises identically", async () => {
      const source = create();
      await source.addDocument([blockA]);
      await source.addDocument([{ ...blockB, metadata: { kind: "note" } }]);
      const saved = await materialise(source);

      const restored = create();
      await restored.loadFrom(toEntries(saved));
      expect(restored.isDirty()).toBe(false);
      expect(await restored.getSize()).toBe(2);
      expect(await collect(restored.getDocumentsBlocks("/docs/b"))).toEqual([
        { ...blockB, metadata: { kind: "note" } },
      ]);
      const hits = await collect(restored.search({ queries: ["gamma"] }));
      expect(hits.map((h) => h.blockId)).toEqual(["b1"]);
      expect(decode(await materialise(restored))).toEqual(decode(saved));
    });

    it("a restored index becomes dirty on its first change", async () => {
      const source = create();
      await source.addDocument([blockA]);
      const restored = create();
      await restored.loadFrom(toEntries(await materialise(source)));
      await restored.addDocument([blockB]);
      expect(restored.isDirty()).toBe(true);
      const again = create();
      await again.loadFrom(toEntries(await materialise(restored)));
      expect(await again.getSize()).toBe(2);
    });
  });
}
