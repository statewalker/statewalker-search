// =============================================================================
// SQL orphan-sweep conformance suite — for backends on the shared SQL kernel
// (`createSqlKernelIndexer`: DuckDB, PGlite, SQLite).
//
// After a delete, the docs-table backends reclaim the doc rows no sub-index
// table references any more. A sub-index whose modality has no provider (kept
// under `onMissingProvider: "warn"`, e.g. after a rollback to a version without
// that modality) still references doc rows. The sweep must count its tables,
// which the manifest entry records, and must skip itself when an entry written
// before the record has such a sub-index (statewalker-search#90).
//
// "Version N" is an indexer with the n-gram provider; "version N−1" is one
// without it. Both run on the same database.
// =============================================================================

import type { DocumentPath, Index, Indexer } from "@statewalker/indexer-api";
import { newFullTextAccess } from "@statewalker/indexer-fulltext";
import { grep, newNgramAccess } from "@statewalker/indexer-ngram";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collect, defined } from "./test-utils.js";

export interface SqlOrphanSweepSuiteOptions<D> {
  /** A fresh, empty database. */
  newDb(): Promise<D>;
  /** Close a database from `newDb` (after every indexer on it is closed). */
  closeDb(db: D): Promise<void>;
  /**
   * An indexer on `db` with the full-text provider, and the n-gram provider when `ngram` is true.
   * Closing it must leave `db` open.
   */
  createIndexer(db: D, opts: { ngram: boolean }): Promise<Indexer>;
  /** Run a query without parameters and return its rows (used to read and edit the manifest). */
  query(db: D, sql: string): Promise<Array<Record<string, unknown>>>;
  /**
   * Whether manifest entries record each sub-index's doc-referencing tables (`docTables`). True
   * for the docs-table backends (DuckDB, PGlite); SQLite never reclaims block ids, so it has no
   * sweep and no record.
   */
  recordsDocTables: boolean;
  /** The number of rows in an Index's docs table, for the backends that have one. */
  countDocRows?(db: D, indexName: string): Promise<number>;
}

const MANIFEST_TABLE = "__indexer_manifest";
const p = (s: string) => s as DocumentPath;
/** The console, typed without the DOM or Node libraries. */
const out = globalThis as unknown as { console: { warn(...args: unknown[]): void } };
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function runSqlOrphanSweepSuite<D>(
  name: string,
  options: SqlOrphanSweepSuiteOptions<D>,
): void {
  describe(`${name} — SQL orphan sweep with a missing provider`, () => {
    let db: D;
    const indexers: Indexer[] = [];

    async function open(ngram: boolean): Promise<Indexer> {
      const indexer = await options.createIndexer(db, { ngram });
      indexers.push(indexer);
      return indexer;
    }

    async function readEntry(indexName: string): Promise<Record<string, unknown>> {
      const rows = await options.query(
        db,
        `SELECT config FROM ${MANIFEST_TABLE} WHERE name = ${quote(indexName)}`,
      );
      return JSON.parse(String(defined(rows[0]).config)) as Record<string, unknown>;
    }

    async function writeEntry(indexName: string, entry: Record<string, unknown>): Promise<void> {
      await options.query(
        db,
        `UPDATE ${MANIFEST_TABLE} SET config = ${quote(JSON.stringify(entry))} WHERE name = ${quote(indexName)}`,
      );
    }

    /** Version N: `/a` in the n-gram sub-index only, `/b` in the full-text one only. */
    async function seed(indexName: string): Promise<void> {
      const indexer = await open(true);
      const index = await indexer.createIndex({
        name: indexName,
        subIndexes: { g: { type: "ngram" }, q: { type: "fulltext", language: "en" } },
      });
      await newNgramAccess("g")
        .get(index)
        .addDocument([{ path: p("/a"), blockId: "1", content: "needle in the ngram index" }]);
      await newFullTextAccess("q")
        .get(index)
        .addDocument([{ path: p("/b"), blockId: "1", content: "hay in the fulltext index" }]);
      await index.flush();
      await indexer.close();
    }

    /** Version N−1 (no n-gram provider), under "warn": delete `/b` through the full-text one. */
    async function deleteThroughRollback(indexName: string): Promise<void> {
      const indexer = await open(false);
      const index = defined(await indexer.getIndex(indexName, { onMissingProvider: "warn" }));
      await index.deleteDocuments([{ path: p("/b") }]);
      expect(await newFullTextAccess("q").get(index).getSize()).toBe(0);
      await indexer.close();
    }

    /** Version N again: `/a` must still be in the n-gram sub-index, enumerated and found. */
    async function expectNgramIntact(indexName: string): Promise<Index> {
      const indexer = await open(true);
      const index = defined(await indexer.getIndex(indexName));
      const g = newNgramAccess("g").get(index);
      expect(await collect(g.getDocumentPaths())).toEqual(["/a"]);
      expect(await collect(g.getDocumentBlocksRefs())).toEqual([{ path: "/a", blockId: "1" }]);
      expect((await grep(index, "g", "needle")).hits.map((h) => h.path)).toEqual(["/a"]);
      return index;
    }

    beforeEach(async () => {
      db = await options.newDb();
      // Silence the "has no provider; skipping" warning of the rollback steps.
      warn = out.console.warn;
      out.console.warn = () => undefined;
    });

    let warn: (...args: unknown[]) => void;
    afterEach(async () => {
      out.console.warn = warn;
      for (const indexer of indexers.splice(0)) await indexer.close().catch(() => undefined);
      await options.closeDb(db);
    });

    it("a delete through another sub-index keeps the doc rows only a provider-less sub-index references", async () => {
      await seed("roll");
      await deleteThroughRollback("roll");
      await expectNgramIntact("roll");
    });

    if (options.countDocRows) {
      const countDocRows = options.countDocRows;
      it("the sweep still reclaims doc rows no recorded table references", async () => {
        await seed("precise");
        expect(await countDocRows(db, "precise")).toBe(2);
        await deleteThroughRollback("precise");
        // `/b`'s doc row is gone; `/a`'s, which the n-gram table references, stays.
        expect(await countDocRows(db, "precise")).toBe(1);
      });
    }

    it("an entry written before the record falls back to skipping the sweep when a provider is missing", async () => {
      await seed("old");
      const entry = await readEntry("old");
      delete entry.docTables;
      await writeEntry("old", entry);

      await deleteThroughRollback("old");
      if (options.countDocRows) {
        // Nothing reclaimed: the sweep cannot account for the n-gram sub-index's rows.
        expect(await options.countDocRows(db, "old")).toBe(2);
      }
      const index = await expectNgramIntact("old");
      if (options.countDocRows) {
        // With every provider back, the next delete sweeps the orphan `/b` left behind.
        await index.deleteDocuments([{ path: p("/nothing") }]);
        expect(await options.countDocRows(db, "old")).toBe(1);
      }
    });

    if (options.recordsDocTables) {
      it("new entries record each sub-index's doc-referencing tables", async () => {
        await seed("rec");
        const recorded = (await readEntry("rec")).docTables as Record<string, string[]>;
        expect(Object.keys(recorded).sort()).toEqual(["g", "q"]);
        for (const tables of Object.values(recorded)) expect(tables.length).toBeGreaterThan(0);
      });

      it("an entry without the record gains it when opened with every provider", async () => {
        await seed("upgrade");
        const entry = await readEntry("upgrade");
        const recorded = entry.docTables;
        delete entry.docTables;
        await writeEntry("upgrade", entry);

        const indexer = await open(true);
        await indexer.getIndex("upgrade");
        expect((await readEntry("upgrade")).docTables).toEqual(recorded);
      });

      it("a rollback keeps the record of the provider-less sub-index through its rewrites", async () => {
        await seed("keep");
        const recorded = (await readEntry("keep")).docTables as Record<string, string[]>;
        const indexer = await open(false);
        // A reinit of `q` rewrites the entry while `g` has no provider.
        await indexer.getIndex("keep", {
          onMissingProvider: "warn",
          subIndexes: { q: { type: "fulltext", language: "fr" } },
        });
        const after = (await readEntry("keep")).docTables as Record<string, string[]>;
        expect(after.g).toEqual(recorded.g);
        expect(after.q).toBeDefined();
      });

      it("a reinit to another modality records the new tables", async () => {
        await seed("swap");
        const before = (await readEntry("swap")).docTables as Record<string, string[]>;
        const indexer = await open(true);
        await indexer.getIndex("swap", {
          subIndexes: { g: { type: "fulltext", language: "en" } },
        });
        const after = (await readEntry("swap")).docTables as Record<string, string[]>;
        expect(after.g?.length).toBeGreaterThan(0);
        expect(after.g).not.toEqual(before.g);
        expect(after.q).toEqual(before.q);
      });
    }
  });
}
