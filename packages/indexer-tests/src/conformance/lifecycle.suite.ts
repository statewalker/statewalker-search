// =============================================================================
// Lifecycle conformance suite — closing, reopening and deleting an Index.
//
// Covers what happens around `index.close()` and `indexer.deleteIndex()`:
//   - a closed Index is evicted, so `getIndex` reopens it with its data;
//   - concurrent `getIndex` calls open one instance;
//   - `deleteIndex` removes everything, also after `index.close()` and for
//     sub-indexes skipped at open, so a new Index of the same name starts empty;
//   - a reinit to an unregistered type fails or skips without dropping data.
//
// Every backend runs it with one full-text and one vector config; data is
// checked through `getSize` on the modality access handles.
// =============================================================================

import type { DocumentPath, Index, Indexer } from "@statewalker/indexer-api";
import { newFullTextAccess } from "@statewalker/indexer-fulltext";
import { newVectorAccess } from "@statewalker/indexer-vector";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryPersistence, type SubIndexConfig } from "./kernel.suite.js";
import { defined } from "./test-utils.js";
import type { IndexerFactory } from "./types.js";

export interface LifecycleSuiteOptions {
  factory: IndexerFactory;
  /** A full-text sub-index config (`type: "fulltext"` plus its fields). */
  fullTextConfig: SubIndexConfig;
  /** A vector sub-index config with `dimensionality: 3`. */
  vectorConfig: SubIndexConfig;
}

const fts = newFullTextAccess("q");
const vec = newVectorAccess("v");

async function addText(index: Index, path: string, content: string): Promise<void> {
  await fts.get(index).addDocument([{ path: path as DocumentPath, blockId: "0", content }]);
  await index.flush();
}

async function addVector(index: Index, path: string): Promise<void> {
  await vec
    .get(index)
    .addDocument([
      { path: path as DocumentPath, blockId: "0", embedding: new Float32Array([1, 0, 0]) },
    ]);
  await index.flush();
}

export function runLifecycleConformanceSuite(name: string, options: LifecycleSuiteOptions): void {
  const { factory, fullTextConfig, vectorConfig } = options;

  describe(`${name} — lifecycle conformance`, () => {
    let indexer: Indexer;

    beforeEach(async () => {
      indexer = await factory.create();
    });

    afterEach(async () => {
      try {
        await indexer.close();
      } catch {
        /* may have been closed by the test */
      }
      await factory.cleanup?.();
    });

    it("getIndex after index.close() reopens the index with its data", async () => {
      const idx = await indexer.createIndex({ name: "a", subIndexes: { q: fullTextConfig } });
      await addText(idx, "/d/1", "hello world");
      await idx.close();

      const reopened = defined(await indexer.getIndex("a"));
      expect(reopened).not.toBe(idx);
      expect(await fts.get(reopened).getSize()).toBe(1);
      await expect(indexer.flush()).resolves.toBeUndefined();
    });

    it("concurrent getIndex calls open one instance", async () => {
      const idx = await indexer.createIndex({ name: "a", subIndexes: { q: fullTextConfig } });
      await addText(idx, "/d/1", "hello");
      await idx.close();

      const [first, second] = await Promise.all([indexer.getIndex("a"), indexer.getIndex("a")]);
      expect(first).not.toBeNull();
      expect(second).toBe(first);
    });

    it("deleteIndex after index.close() deletes the index and its data", async () => {
      const idx = await indexer.createIndex({ name: "a", subIndexes: { q: fullTextConfig } });
      await addText(idx, "/d/1", "hello");
      await idx.close();

      await indexer.deleteIndex("a");
      expect(await indexer.hasIndex("a")).toBe(false);
      expect(await indexer.getIndex("a")).toBeNull();

      const again = await indexer.createIndex({ name: "a", subIndexes: { q: fullTextConfig } });
      expect(await fts.get(again).getSize()).toBe(0);
    });

    it("index.deleteIndex() also removes sub-indexes skipped at open", async () => {
      const idx = await indexer.createIndex({
        name: "a",
        subIndexes: { q: fullTextConfig, v: vectorConfig },
      });
      await addText(idx, "/d/1", "hello");
      await addVector(idx, "/d/1");
      await idx.close();

      const partial = defined(await indexer.getIndex("a", { subIndexes: { v: { skip: true } } }));
      expect(partial.getBinding("v")).toBeUndefined();
      await partial.deleteIndex();
      expect(await indexer.hasIndex("a")).toBe(false);

      const again = await indexer.createIndex({
        name: "a",
        subIndexes: { q: fullTextConfig, v: vectorConfig },
      });
      expect(await fts.get(again).getSize()).toBe(0);
      expect(await vec.get(again).getSize()).toBe(0);
    });

    it("indexer.deleteIndex() also removes sub-indexes skipped at open", async () => {
      const idx = await indexer.createIndex({
        name: "a",
        subIndexes: { q: fullTextConfig, v: vectorConfig },
      });
      await addVector(idx, "/d/1");
      await idx.close();
      await indexer.getIndex("a", { subIndexes: { v: { skip: true } } });

      await indexer.deleteIndex("a");
      const again = await indexer.createIndex({
        name: "a",
        subIndexes: { q: fullTextConfig, v: vectorConfig },
      });
      expect(await vec.get(again).getSize()).toBe(0);
    });

    it("a reinit to an unregistered type throws and keeps the saved data", async () => {
      const idx = await indexer.createIndex({ name: "a", subIndexes: { q: fullTextConfig } });
      await addText(idx, "/d/1", "hello");
      await idx.close();

      await expect(
        indexer.getIndex("a", { subIndexes: { q: { type: "no-such-modality" } } }),
      ).rejects.toThrow();

      const reopened = defined(await indexer.getIndex("a"));
      expect(await fts.get(reopened).getSize()).toBe(1);
    });

    it("a reinit to an unregistered type under onMissingProvider 'warn' skips it and keeps the data", async () => {
      const idx = await indexer.createIndex({ name: "a", subIndexes: { q: fullTextConfig } });
      await addText(idx, "/d/1", "hello");
      await idx.close();

      const warned = defined(
        await indexer.getIndex("a", {
          onMissingProvider: "warn",
          subIndexes: { q: { type: "no-such-modality" } },
        }),
      );
      expect(warned.getBinding("q")).toBeUndefined();
      await warned.close();

      const reopened = defined(await indexer.getIndex("a"));
      expect(await fts.get(reopened).getSize()).toBe(1);
    });

    it("index metadata survives close and reopen, and getIndexNames returns it", async () => {
      const metadata = { owner: "team-a", version: 2 };
      const idx = await indexer.createIndex({
        name: "a",
        subIndexes: { q: fullTextConfig },
        metadata,
      });
      expect(idx.metadata).toEqual(metadata);
      await idx.close();

      const reopened = defined(await indexer.getIndex("a"));
      expect(reopened.metadata).toEqual(metadata);
      expect(await indexer.getIndexNames()).toEqual([{ name: "a", metadata }]);
    });

    it("index metadata survives a save and reload", async () => {
      const createWithPersistence = factory.createWithPersistence;
      if (!createWithPersistence) return; // the backend stores everything in its database

      const persistence = new MemoryPersistence();
      const first = await createWithPersistence(persistence);
      await first.createIndex({ name: "a", subIndexes: { q: fullTextConfig }, metadata: { k: 1 } });
      await first.close();

      const second = await createWithPersistence(persistence);
      try {
        expect(await second.getIndexNames()).toEqual([{ name: "a", metadata: { k: 1 } }]);
        expect(defined(await second.getIndex("a")).metadata).toEqual({ k: 1 });
      } finally {
        await second.close();
      }
    });

    it("a vector batch with one wrong-size block writes nothing", async () => {
      const idx = await indexer.createIndex({ name: "a", subIndexes: { v: vectorConfig } });
      await expect(
        vec.get(idx).addDocument([
          { path: "/d/1" as DocumentPath, blockId: "0", embedding: new Float32Array([1, 0, 0]) },
          { path: "/d/2" as DocumentPath, blockId: "0", embedding: new Float32Array([1, 0]) },
        ]),
      ).rejects.toThrow("Expected dimensionality 3, got 2");
      expect(await vec.get(idx).getSize()).toBe(0);
    });

    it("data written through concurrently opened handles survives a save and reload", async () => {
      const createWithPersistence = factory.createWithPersistence;
      if (!createWithPersistence) return; // the backend stores everything in its database

      const persistence = new MemoryPersistence();
      const first = await createWithPersistence(persistence);
      await first.createIndex({ name: "a", subIndexes: { q: fullTextConfig } });
      await first.close();

      const second = await createWithPersistence(persistence);
      const [x, y] = await Promise.all([second.getIndex("a"), second.getIndex("a")]);
      expect(y).toBe(x);
      await addText(defined(x), "/d/1", "hello");
      await second.close();

      const third = await createWithPersistence(persistence);
      try {
        const reloaded = defined(await third.getIndex("a"));
        expect(await fts.get(reloaded).getSize()).toBe(1);
      } finally {
        await third.close();
      }
    });
  });
}
