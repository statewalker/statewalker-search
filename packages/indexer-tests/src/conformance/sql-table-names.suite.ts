// =============================================================================
// SQL table-name conformance suite — for backends built on `createSqlIndexer`.
//
// Postgres and DuckDB fold unquoted identifiers to lower case, and Postgres
// cuts them to 63 bytes. The suite checks that index and sub-index names that
// differ only in case, or that are long, get tables of their own, and that
// databases written by earlier versions (upper case kept, no length bound)
// still open: `createLegacyIndexer` writes tables under that earlier scheme.
// =============================================================================

import type { DocumentPath, Index, Indexer } from "@statewalker/indexer-api";
import { newFullTextAccess } from "@statewalker/indexer-fulltext";
import { newVectorAccess } from "@statewalker/indexer-vector";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubIndexConfig } from "./kernel.suite.js";
import { collect, defined } from "./test-utils.js";

export interface SqlTableNamesSuiteOptions<D> {
  /** A fresh, empty database. */
  newDb(): Promise<D>;
  /** Close a database from `newDb` (after every indexer on it is closed). */
  closeDb(db: D): Promise<void>;
  /** An indexer of the current version on `db`; closing it must leave `db` open. */
  createIndexer(db: D): Promise<Indexer>;
  /** An indexer that creates tables under the earlier versions' naming scheme, on `db`. */
  createLegacyIndexer(db: D): Promise<Indexer>;
  /** A full-text sub-index config. */
  fullTextConfig: SubIndexConfig;
  /** A vector sub-index config with `dimensionality: 3`. */
  vectorConfig: SubIndexConfig;
}

const LONG_SUB_1 = "body-english-stemmed-paragraph-level-chunks-v1";
const LONG_SUB_2 = "body-english-stemmed-paragraph-level-chunks-v2";
const LONG_INDEX = "projects/acme/workspace/documents/knowledge-base/alpha";

async function addText(index: Index, sub: string, path: string, content: string): Promise<void> {
  await newFullTextAccess(sub)
    .get(index)
    .addDocument([{ path: path as DocumentPath, blockId: "0", content }]);
  await index.flush();
}

async function addVector(index: Index, sub: string, path: string): Promise<void> {
  await newVectorAccess(sub)
    .get(index)
    .addDocument([
      { path: path as DocumentPath, blockId: "0", embedding: new Float32Array([1, 0, 0]) },
    ]);
  await index.flush();
}

async function textSize(index: Index, sub: string): Promise<number> {
  return newFullTextAccess(sub).get(index).getSize();
}

async function textHits(index: Index, sub: string, query: string): Promise<string[]> {
  const hits = await collect(
    newFullTextAccess(sub)
      .get(index)
      .search({ queries: [query] }),
  );
  return hits.map((h) => h.path);
}

export function runSqlTableNamesSuite<D>(
  name: string,
  options: SqlTableNamesSuiteOptions<D>,
): void {
  const { fullTextConfig: ft, vectorConfig: vec } = options;

  describe(`${name} — SQL table names`, () => {
    let db: D;
    const indexers: Indexer[] = [];
    const open = async (legacy = false): Promise<Indexer> => {
      const indexer = await (legacy ? options.createLegacyIndexer(db) : options.createIndexer(db));
      indexers.push(indexer);
      return indexer;
    };

    beforeEach(async () => {
      db = await options.newDb();
    });

    afterEach(async () => {
      for (const indexer of indexers.splice(0)) {
        try {
          await indexer.close();
        } catch {
          /* already closed */
        }
      }
      await options.closeDb(db);
    });

    it("index names that differ only in case get their own tables", async () => {
      const indexer = await open();
      const upper = await indexer.createIndex({ name: "Notes", subIndexes: { q: ft } });
      const lower = await indexer.createIndex({ name: "notes", subIndexes: { q: ft } });
      await addText(upper, "q", "/u", "upper");
      await addText(lower, "q", "/l", "lower");
      expect(await textSize(upper, "q")).toBe(1);
      expect(await textSize(lower, "q")).toBe(1);

      await indexer.deleteIndex("notes");
      expect(await textSize(upper, "q")).toBe(1);
      expect(await textHits(upper, "q", "upper")).toEqual(["/u"]);
    });

    it("sub-index names that differ only in case get their own tables", async () => {
      const indexer = await open();
      const idx = await indexer.createIndex({ name: "n", subIndexes: { Q: ft, q: ft } });
      await addText(idx, "Q", "/u", "upper");
      expect(await textSize(idx, "q")).toBe(0);
    });

    it("long sub-index names that share their first 63 bytes get their own tables", async () => {
      const indexer = await open();
      const idx = await indexer.createIndex({
        name: "kb",
        subIndexes: { [LONG_SUB_1]: ft, [LONG_SUB_2]: ft },
      });
      await addText(idx, LONG_SUB_1, "/a", "alpha");
      expect(await textSize(idx, LONG_SUB_2)).toBe(0);
      await newFullTextAccess(LONG_SUB_2)
        .get(idx)
        .deleteDocuments([{ path: "/" as DocumentPath }]);
      expect(await textSize(idx, LONG_SUB_1)).toBe(1);
    });

    it("a long index name works and keeps its data across close and reopen", async () => {
      const indexer = await open();
      const idx = await indexer.createIndex({ name: LONG_INDEX, subIndexes: { q: ft, v: vec } });
      await addText(idx, "q", "/a", "alpha");
      await addVector(idx, "v", "/a");
      await idx.close();

      const reopened = defined(await indexer.getIndex(LONG_INDEX));
      expect(await textSize(reopened, "q")).toBe(1);
      expect(await textHits(reopened, "q", "alpha")).toEqual(["/a"]);
      expect(await newVectorAccess("v").get(reopened).getSize()).toBe(1);
    });

    it("opens an upper-case index written by an earlier version, and deletes it", async () => {
      const legacy = await open(true);
      const old = await legacy.createIndex({ name: "Notes", subIndexes: { q: ft, v: vec } });
      await addText(old, "q", "/a", "alpha");
      await addVector(old, "v", "/a");
      await legacy.close();

      const indexer = await open();
      const idx = defined(await indexer.getIndex("Notes"));
      expect(await textSize(idx, "q")).toBe(1);
      expect(await textHits(idx, "q", "alpha")).toEqual(["/a"]);
      expect(await newVectorAccess("v").get(idx).getSize()).toBe(1);
      await addText(idx, "q", "/b", "beta");
      await indexer.close();

      const again = await open();
      const reopened = defined(await again.getIndex("Notes"));
      expect(await textSize(reopened, "q")).toBe(2);
      await reopened.deleteDocuments([{ path: "/a" as DocumentPath }]);
      expect(await textSize(reopened, "q")).toBe(1);
      expect(await newVectorAccess("v").get(reopened).getSize()).toBe(0);

      await again.deleteIndex("Notes");
      const fresh = await again.createIndex({ name: "Notes", subIndexes: { q: ft } });
      expect(await textSize(fresh, "q")).toBe(0);
      // The earlier version's tables are gone too.
      const legacyAgain = await open(true);
      await legacyAgain.deleteIndex("Notes");
      const legacyFresh = await legacyAgain.createIndex({ name: "Notes", subIndexes: { q: ft } });
      expect(await textSize(legacyFresh, "q")).toBe(0);
    });

    it("opens a long-named sub-index written by an earlier version", async () => {
      const legacy = await open(true);
      const old = await legacy.createIndex({ name: "kb", subIndexes: { [LONG_SUB_1]: ft } });
      await addText(old, LONG_SUB_1, "/a", "alpha");
      await legacy.close();

      const indexer = await open();
      const idx = defined(await indexer.getIndex("kb"));
      expect(await textSize(idx, LONG_SUB_1)).toBe(1);
      expect(await textHits(idx, LONG_SUB_1, "alpha")).toEqual(["/a"]);
    });

    it("refuses to create an index whose tables an earlier version's index already uses", async () => {
      const legacy = await open(true);
      const old = await legacy.createIndex({ name: "Notes", subIndexes: { q: ft } });
      await addText(old, "q", "/a", "alpha");
      await legacy.close();

      const indexer = await open();
      await expect(indexer.createIndex({ name: "notes", subIndexes: { q: ft } })).rejects.toThrow(
        /earlier version/,
      );
      expect(await indexer.hasIndex("notes")).toBe(false);
      expect(await textSize(defined(await indexer.getIndex("Notes")), "q")).toBe(1);
    });
  });
}
