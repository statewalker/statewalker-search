// =============================================================================
// SQL n-gram specifics — what the docs-table backends (DuckDB, PGlite) must do
// beyond the backend-agnostic `runNgramConformanceSuite`: report their store,
// refuse a store they lack, keep doc rows the n-gram table references through
// the orphan sweep, survive a reopen, drop their table, and plan patterns the
// way the SQLite backend does (truncation, topK, pattern errors, case folding
// beyond ASCII, alternation, patterns with no usable literal).
// =============================================================================

import type { DocumentPath, Index, Indexer, IndexerPersistence } from "@statewalker/indexer-api";
import { newFullTextAccess } from "@statewalker/indexer-fulltext";
import { grep, newNgramAccess } from "@statewalker/indexer-ngram";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryPersistence } from "./kernel.suite.js";
import { collect, defined } from "./test-utils.js";
import type { IndexerFactory } from "./types.js";

export interface SqlNgramSuiteOptions {
  /** `createWithPersistence(p)` must reopen the same database for the same `p`. */
  factory: IndexerFactory & {
    createWithPersistence(persistence: IndexerPersistence): Promise<Indexer>;
  };
  /** The value `getIndexInfo().store` reports, and the one store the backend accepts. */
  store: string;
  /** A store value this backend does not have. */
  foreignStore: string;
}

const p = (s: string) => s as DocumentPath;
const access = newNgramAccess("g");

export function runSqlNgramSuite(name: string, options: SqlNgramSuiteOptions): void {
  const { factory, store, foreignStore } = options;

  describe(`${name} — SQL n-gram specifics`, () => {
    const indexers: Indexer[] = [];
    async function newIndexer(): Promise<Indexer> {
      const indexer = await factory.create();
      indexers.push(indexer);
      return indexer;
    }
    async function newIndex(content: Record<string, string> = {}): Promise<Index> {
      const indexer = await newIndexer();
      const index = await indexer.createIndex({
        name: "ng",
        subIndexes: { g: { type: "ngram" } },
      });
      const sub = access.get(index);
      for (const [path, text] of Object.entries(content)) {
        await sub.addDocument([{ path: p(path), blockId: "1", content: text }]);
      }
      return index;
    }

    afterEach(async () => {
      for (const indexer of indexers.splice(0)) await indexer.close().catch(() => undefined);
      await factory.cleanup?.();
    });

    it("reports its store, by default and when asked for by name", async () => {
      const indexer = await newIndexer();
      const index = await indexer.createIndex({
        name: "a",
        subIndexes: { g: { type: "ngram" }, h: { type: "ngram", store } },
      });
      expect(await access.get(index).getIndexInfo()).toEqual({ store });
      expect(await newNgramAccess("h").get(index).getIndexInfo()).toEqual({ store });
    });

    it("refuses a store it does not have", async () => {
      const indexer = await newIndexer();
      await expect(
        indexer.createIndex({
          name: "b",
          subIndexes: { g: { type: "ngram", store: foreignStore } },
        }),
      ).rejects.toThrow(new RegExp(foreignStore));
    });

    it("keeps the doc rows only the n-gram table references through the orphan sweep", async () => {
      const indexer = await newIndexer();
      const index = await indexer.createIndex({
        name: "c",
        subIndexes: { g: { type: "ngram" }, q: { type: "fulltext", language: "en" } },
      });
      const ng = access.get(index);
      const ft = newFullTextAccess("q").get(index);
      await ng.addDocument([{ path: p("/only-ngram"), blockId: "1", content: "needle here" }]);
      await ft.addDocument([{ path: p("/only-fts"), blockId: "1", content: "hay" }]);
      // Deleting through the full-text sub-index runs the orphan sweep over the docs table.
      await ft.deleteDocuments([{ path: p("/only-fts") }]);
      expect(await collect(ng.getDocumentBlocksRefs())).toEqual([
        { path: "/only-ngram", blockId: "1" },
      ]);
      expect((await grep(index, "g", "needle")).hits.map((h) => h.path)).toEqual(["/only-ngram"]);
      // Once the n-gram rows go too, the sweep reclaims the doc row: re-adding starts clean.
      await ng.deleteDocuments([{ path: p("/only-ngram") }]);
      expect(await ng.getSize()).toBe(0);
      await ng.addDocument([{ path: p("/only-ngram"), blockId: "2", content: "needle again" }]);
      expect(await collect(ng.getDocumentBlocksRefs())).toEqual([
        { path: "/only-ngram", blockId: "2" },
      ]);
    });

    it("enumerates, counts and returns stored blocks under a prefix", async () => {
      const index = await newIndex({ "/a/x": "one", "/a/y": "two", "/b/z": "three" });
      const sub = access.get(index);
      expect(await sub.getSize()).toBe(3);
      expect(await sub.getSize(p("/a"))).toBe(2);
      expect((await collect(sub.getDocumentPaths(p("/a")))).sort()).toEqual(["/a/x", "/a/y"]);
      expect(await collect(sub.getDocumentsBlocks(p("/b")))).toEqual([
        { path: "/b/z", blockId: "1", content: "three" },
      ]);
    });

    it("survives a reopen of the database", async () => {
      const persistence = new MemoryPersistence();
      const first = await factory.createWithPersistence(persistence);
      const index = await first.createIndex({ name: "d", subIndexes: { g: { type: "ngram" } } });
      await access.get(index).addDocument([{ path: p("/r"), blockId: "1", content: "Persisted" }]);
      await first.close();
      const again = await factory.createWithPersistence(persistence);
      indexers.push(again);
      const reopened = defined(await again.getIndex("d"));
      const { hits } = await grep(reopened, "g", "persisted", { caseSensitive: false });
      expect(hits.map((h) => h.path)).toEqual(["/r"]);
    });

    it("deleteIndex drops the n-gram table: a new index of the same name starts empty", async () => {
      const indexer = await newIndexer();
      const index = await indexer.createIndex({ name: "e", subIndexes: { g: { type: "ngram" } } });
      await access.get(index).addDocument([{ path: p("/x"), blockId: "1", content: "gone soon" }]);
      await indexer.deleteIndex("e");
      const fresh = await indexer.createIndex({ name: "e", subIndexes: { g: { type: "ngram" } } });
      expect(await access.get(fresh).getSize()).toBe(0);
      expect((await grep(fresh, "g", "gone")).hits).toEqual([]);
    });

    it("cuts to topK and reports truncation; topK 0 returns nothing, truncated", async () => {
      const index = await newIndex({ "/1": "dup dup", "/2": "dup", "/3": "dup dup dup" });
      const all = await grep(index, "g", "dup");
      expect(all.truncated).toBe(false);
      expect(all.hits.map((h) => [h.path, h.count])).toEqual([
        ["/3", 3],
        ["/1", 2],
        ["/2", 1],
      ]);
      const one = await grep(index, "g", "dup", { topK: 1 });
      expect(one.truncated).toBe(true);
      expect(one.hits).toHaveLength(1);
      expect(await grep(index, "g", "dup", { topK: 0 })).toEqual({ hits: [], truncated: true });
    });

    it("rejects \\p{…} in regex mode and patterns over 1000 characters", async () => {
      const index = await newIndex({ "/a": "text" });
      await expect(grep(index, "g", "\\p{L}", { regex: true })).rejects.toThrow(SyntaxError);
      await expect(grep(index, "g", "x".repeat(1001))).rejects.toThrow(RangeError);
    });

    it("folds case beyond ASCII and finds astral characters", async () => {
      const index = await newIndex({ "/greek": "ΣΊΣΥΦΟΣ rolls", "/emoji": "say 😀😀 twice" });
      const greek = await grep(index, "g", "σίσυφος", { caseSensitive: false });
      expect(greek.hits.map((h) => [h.path, h.matches[0]])).toEqual([
        ["/greek", { start: 0, end: 7, line: 1 }],
      ]);
      expect((await grep(index, "g", "σίσυφος")).hits).toEqual([]);
      const emoji = await grep(index, "g", "😀😀");
      expect(emoji.hits.map((h) => [h.path, h.matches[0]])).toEqual([
        ["/emoji", { start: 4, end: 8, line: 1 }],
      ]);
    });

    it("answers alternations and patterns with no usable literal", async () => {
      const index = await newIndex({ "/a": "alpha\nbeta", "/b": "gamma", "/c": "x1" });
      const alt = await grep(index, "g", "alpha|gamma", { regex: true });
      expect(alt.hits.map((h) => h.path).sort()).toEqual(["/a", "/b"]);
      const digits = await grep(index, "g", "\\d", { regex: true });
      expect(digits.hits.map((h) => h.path)).toEqual(["/c"]);
      // Empty matches are not matches.
      expect((await grep(index, "g", "z*", { regex: true })).hits).toEqual([]);
      const lines = await grep(index, "g", "^beta$", { regex: true });
      expect(lines.hits).toEqual([]);
      const multiline = await grep(index, "g", "a\nb");
      expect(multiline.hits.map((h) => [h.path, h.matches[0]?.line])).toEqual([["/a", 1]]);
    });

    it("reads LIKE and SQL metacharacters in a pattern literally", async () => {
      const index = await newIndex({ "/a": "100% of a_b", "/b": "1000 of aXb", "/c": "it's" });
      expect((await grep(index, "g", "0% of a_b")).hits.map((h) => h.path)).toEqual(["/a"]);
      expect((await grep(index, "g", "it's")).hits.map((h) => h.path)).toEqual(["/c"]);
    });
  });
}
