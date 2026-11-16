// =============================================================================
// DuckDB Indexer conformance — wires through the kernel / RRF-blending /
// multi-instance conformance suites, plus SQL-specific scenarios inlined
// here (docs-table reclamation, manifest survival across reopen, concurrent
// overwrite serialization).
//
// Per-modality FTS / vector conformance suites are Provider-based and don't
// fit SQL; FTS + vector semantics are exercised through the Indexer-driven
// suites instead.
// =============================================================================

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newNodeDuckDb } from "@statewalker/db-duckdb-node";
import type { DocumentPath, Index, IndexerPersistence } from "@statewalker/indexer-api";
import {
  createSqlFtsRetriever,
  createSqlIndexer,
  createSqlNgramRetriever,
  legacySqlTableNaming,
  type SqlDocsModalityProvider,
  sqlDocsTableName,
  sqlTableNaming,
} from "@statewalker/indexer-core";
import type { FullTextConfig, FullTextIndex, FulltextQuery } from "@statewalker/indexer-fulltext";
import { newFullTextAccess } from "@statewalker/indexer-fulltext";
import {
  collect,
  defined,
  runFullTextMultiWordSuite,
  runKernelConformanceSuite,
  runLifecycleConformanceSuite,
  runMultiInstanceConformanceSuite,
  runNgramConformanceSuite,
  runRrfBlendingSuite,
  runSqlNgramSuite,
  runSqlOrphanSweepSuite,
  runSqlTableNamesSuite,
} from "@statewalker/indexer-tests";
import type { VectorQuery } from "@statewalker/indexer-vector";
import { newVectorAccess } from "@statewalker/indexer-vector";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { duckdbDialect, duckdbFtsDialect, wrapDbAsSqlDb } from "../src/dialect.js";
import { createDuckDbIndexer } from "../src/duckdb-indexer.js";

const TEST_DB_DIR = join(fileURLToPath(new URL(".", import.meta.url)), ".testdb");

// The kernel suite's "persistence" is the database itself: `createWithPersistence(p)` reuses one
// in-memory database per `p`, so a second indexer reopens what the first one wrote.
const dbsByPersistence = new WeakMap<
  IndexerPersistence,
  Awaited<ReturnType<typeof newNodeDuckDb>>
>();
const inMemFactory = {
  create: async () => {
    const db = await newNodeDuckDb();
    return createDuckDbIndexer({ db });
  },
  createWithPersistence: async (persistence: IndexerPersistence) => {
    let db = dbsByPersistence.get(persistence);
    if (!db) {
      db = await newNodeDuckDb();
      dbsByPersistence.set(persistence, db);
    }
    return createDuckDbIndexer({ db });
  },
};

const ftConfig = { type: "fulltext" as const, language: "en" };
const vecConfig = { type: "vector" as const, dimensionality: 3, model: "test" };

runKernelConformanceSuite("DuckDB Indexer - in memory", {
  factory: inMemFactory,
  primaryConfig: ftConfig,
  secondaryConfig: vecConfig,
});

runLifecycleConformanceSuite("DuckDB Indexer - in memory", {
  factory: inMemFactory,
  fullTextConfig: ftConfig,
  vectorConfig: vecConfig,
});

const ftAccess = newFullTextAccess("q");
runRrfBlendingSuite("DuckDB FTS", {
  factory: inMemFactory,
  config: ftConfig,
  populate: async (index: Index) => {
    const sub = ftAccess.get(index);
    await sub.addDocument([{ path: "/d/a", blockId: "a", content: "alpha alpha alpha" }]);
    await sub.addDocument([{ path: "/d/b", blockId: "b", content: "alpha beta" }]);
    await sub.addDocument([{ path: "/d/c", blockId: "c", content: "alpha gamma" }]);
    await index.flush();
  },
  buildQuery: ({ topK }) =>
    ({
      queries: ["alpha"],
      ...(topK !== undefined ? { topK } : {}),
    }) satisfies FulltextQuery,
});

// Cross-backend multi-word FTS contract (partial match, coverage-ranked).
runFullTextMultiWordSuite("DuckDB FTS", { factory: inMemFactory, config: ftConfig });

runMultiInstanceConformanceSuite("DuckDB Indexer", {
  factory: inMemFactory,
  fullText: {
    configs: [
      () => ({ type: "fulltext", language: "en" }),
      () => ({ type: "fulltext", language: "fr" }),
    ],
    ingest: async (index, name, block) => {
      const access = newFullTextAccess(name);
      await access.get(index).addDocument([block]);
      await index.flush();
    },
    buildQuery: (query: string) => ({ queries: [query] }) satisfies FulltextQuery,
  },
  vector: {
    configs: [
      () => ({ type: "vector", dimensionality: 3, model: "model-a" }),
      () => ({ type: "vector", dimensionality: 3, model: "model-b" }),
    ],
    ingest: async (index, name, block) => {
      const access = newVectorAccess(name);
      await access.get(index).addDocument([block]);
    },
    buildQuery: (embedding: Float32Array) => ({ embeddings: [embedding] }) satisfies VectorQuery,
  },
});

// =============================================================================
// DuckDB on-disk basic round-trip.
// =============================================================================

describe("DuckDB Indexer - on disk", () => {
  beforeEach(() => {
    if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
    mkdirSync(TEST_DB_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
  });

  it("createIndex + addDocument + search round-trip on disk", async () => {
    const dbPath = join(TEST_DB_DIR, "test.duckdb");
    const db = await newNodeDuckDb({ path: dbPath });
    const indexer = await createDuckDbIndexer({ db });
    try {
      const idx = await indexer.createIndex({
        name: "ondisk",
        subIndexes: { q: ftConfig },
      });
      const fts = newFullTextAccess("q").get(idx);
      await fts.addDocument([{ path: "/d/1" as DocumentPath, blockId: "a", content: "hello" }]);
      await idx.flush();
      expect(await fts.getSize()).toBe(1);
    } finally {
      await indexer.close();
    }
  });
});

// =============================================================================
// SQL-specific scenarios.
// =============================================================================

describe("DuckDB Indexer — docs-table reclamation", () => {
  let db: Awaited<ReturnType<typeof newNodeDuckDb>>;
  let indexer: Awaited<ReturnType<typeof createDuckDbIndexer>>;

  beforeEach(async () => {
    db = await newNodeDuckDb();
    indexer = await createDuckDbIndexer({ db });
  });

  afterEach(async () => {
    try {
      await indexer.close();
    } catch {
      /* */
    }
  });

  async function countDocsRows(indexName: string): Promise<number> {
    const prefix = sqlTableNaming.indexPrefix(indexName);
    const rows = await db.query<{ cnt: number | bigint }>(
      `SELECT COUNT(*) AS cnt FROM idx_${prefix}_docs`,
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  it("FTS-only index: full deletion empties the docs table", async () => {
    const idx = await indexer.createIndex({
      name: "reclaim_fts",
      subIndexes: { q: ftConfig },
    });
    const fts = newFullTextAccess("q").get(idx);
    await fts.addDocument([
      { path: "/d/1" as DocumentPath, blockId: "a", content: "hello" },
      { path: "/d/2" as DocumentPath, blockId: "b", content: "world" },
    ]);
    expect(await countDocsRows("reclaim_fts")).toBeGreaterThan(0);

    await idx.deleteDocuments([{ path: "/d/" as DocumentPath }]);
    expect(await countDocsRows("reclaim_fts")).toBe(0);
  });

  it("a modality added through providers runs over the docs table and counts in the orphan sweep", async () => {
    // A second full-text modality under its own type, built from the same retriever.
    const notes: SqlDocsModalityProvider<FullTextConfig> = {
      type: "notes",
      docTables: (ctx) => [`idx_${ctx.prefix}_notes`],
      async open({ db: sqlDb, prefix, docsTable }, config) {
        const retriever = createSqlFtsRetriever({
          db: sqlDb,
          prefix: `${prefix}_notes_x`,
          docsTable,
          info: { language: config.language },
          dialect: duckdbFtsDialect,
        });
        await retriever.init();
        await sqlDb.exec(
          `CREATE OR REPLACE VIEW idx_${prefix}_notes AS SELECT doc_id FROM idx_${prefix}_notes_x_fts`,
        );
        return retriever;
      },
      async drop({ db: sqlDb, prefix }) {
        await sqlDb.exec(`DROP VIEW IF EXISTS idx_${prefix}_notes`);
        await duckdbFtsDialect.drop?.({ db: sqlDb, tableName: `idx_${prefix}_notes_x_fts` });
        await sqlDb.exec(`DROP TABLE IF EXISTS idx_${prefix}_notes_x_fts`);
      },
    };
    const custom = await createSqlIndexer({
      db: wrapDbAsSqlDb(db),
      dialect: duckdbDialect,
      providers: [notes],
    });
    const idx = await custom.createIndex({
      name: "custom",
      subIndexes: { q: ftConfig, n: { type: "notes", language: "en" } },
    });
    const n = defined(idx.getBinding("n")).index as FullTextIndex;
    await n.addDocument([{ path: "/d/1" as DocumentPath, blockId: "a", content: "hello" }]);
    await newFullTextAccess("q")
      .get(idx)
      .addDocument([{ path: "/d/2" as DocumentPath, blockId: "a", content: "world" }]);
    expect((await collect(n.search({ queries: ["hello"] }))).map((h) => h.path)).toEqual(["/d/1"]);

    // Deleting /d/2 keeps /d/1's docs row, which only the added modality references.
    await idx.deleteDocuments([{ path: "/d/2" as DocumentPath }]);
    expect(await countDocsRows("custom")).toBe(1);
    expect(await collect(n.getDocumentPaths())).toEqual(["/d/1"]);
    await custom.deleteIndex("custom");
    expect(await custom.hasIndex("custom")).toBe(false);
  });

  it("mixed index: composite deleteDocuments reclaims orphans across FTS + vector", async () => {
    const idx = await indexer.createIndex({
      name: "reclaim_mixed",
      subIndexes: { q: ftConfig, v: vecConfig },
    });
    const fts = newFullTextAccess("q").get(idx);
    const vec = newVectorAccess("v").get(idx);
    await fts.addDocument([{ path: "/d/1" as DocumentPath, blockId: "a", content: "x" }]);
    await vec.addDocument([
      { path: "/d/1" as DocumentPath, blockId: "a", embedding: new Float32Array([1, 0, 0]) },
    ]);
    expect(await countDocsRows("reclaim_mixed")).toBeGreaterThan(0);

    await idx.deleteDocuments([{ path: "/d/" as DocumentPath }]);
    expect(await countDocsRows("reclaim_mixed")).toBe(0);
  });
});

describe("DuckDB Indexer — manifest survival across reopen", () => {
  it("createIndex + close + reopen via new Indexer instance preserves index list", async () => {
    const dbPath = join(TEST_DB_DIR, "manifest.duckdb");
    if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
    mkdirSync(TEST_DB_DIR, { recursive: true });
    try {
      {
        const db = await newNodeDuckDb({ path: dbPath });
        const indexer1 = await createDuckDbIndexer({ db });
        await indexer1.createIndex({ name: "persist", subIndexes: { q: ftConfig } });
        await indexer1.flush();
        await indexer1.close();
      }
      {
        const db = await newNodeDuckDb({ path: dbPath });
        const indexer2 = await createDuckDbIndexer({ db });
        try {
          expect(await indexer2.hasIndex("persist")).toBe(true);
          const idx = await indexer2.getIndex("persist");
          expect(idx).not.toBeNull();
          expect(idx?.getBinding("q")?.type).toBe("fulltext");
          const fts = newFullTextAccess("q").get(idx as Index);
          await fts.addDocument([
            { path: "/after" as DocumentPath, blockId: "b", content: "after-reopen" },
          ]);
          expect(await fts.getSize()).toBe(1);
        } finally {
          await indexer2.close();
        }
      }
    } finally {
      if (existsSync(TEST_DB_DIR)) rmSync(TEST_DB_DIR, { recursive: true });
    }
  });
});

describe("DuckDB Indexer — concurrent createIndex overwrites are serialised", () => {
  it("Promise.all([createIndex(overwrite), createIndex(overwrite)]) leaves exactly one manifest row", async () => {
    const db = await newNodeDuckDb();
    const indexer = await createDuckDbIndexer({ db });
    try {
      await indexer.createIndex({ name: "race", subIndexes: { q: ftConfig } });

      await Promise.all([
        indexer.createIndex({ name: "race", subIndexes: { q: ftConfig }, overwrite: true }),
        indexer.createIndex({ name: "race", subIndexes: { q: ftConfig }, overwrite: true }),
      ]);

      const rows = await db.query<{ cnt: number | bigint }>(
        "SELECT COUNT(*) AS cnt FROM __indexer_manifest WHERE name = $1",
        ["race"],
      );
      expect(Number(rows[0]?.cnt ?? 0)).toBe(1);
      expect(await indexer.hasIndex("race")).toBe(true);
    } finally {
      await indexer.close();
    }
  });
});

describe("DuckDB Indexer — full-text writes that fail part-way", () => {
  it("blocks inserted before a failing block are searchable", async () => {
    const db = await newNodeDuckDb();
    const indexer = await createDuckDbIndexer({ db });
    try {
      const idx = await indexer.createIndex({ name: "partial", subIndexes: { q: ftConfig } });
      const fts = newFullTextAccess("q").get(idx);
      // Prime the index so a rebuild has already run and the retriever is clean.
      await fts.addDocument([{ path: "/d/0" as DocumentPath, blockId: "0", content: "zero" }]);
      expect(
        (await collect(idx.search({ topK: 5, subQueries: { q: { queries: ["zero"] } } }))).length,
      ).toBe(1);

      // The second block violates `content NOT NULL`, so the batch fails after the first insert.
      await expect(
        fts.addDocument([
          { path: "/d/1" as DocumentPath, blockId: "a", content: "kept" },
          { path: "/d/2" as DocumentPath, blockId: "b", content: null as unknown as string },
        ]),
      ).rejects.toThrow();

      const hits = await collect(idx.search({ topK: 5, subQueries: { q: { queries: ["kept"] } } }));
      expect(hits.map((h) => h.blockId)).toEqual(["a"]);
    } finally {
      await indexer.close();
    }
  });
});

describe("DuckDB Indexer — full-text index schema cleanup", () => {
  async function ftsSchemas(db: Awaited<ReturnType<typeof newNodeDuckDb>>): Promise<string[]> {
    const rows = await db.query<{ schema_name: string }>(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'fts_main_%'",
    );
    return rows.map((r) => r.schema_name);
  }

  async function indexWithFts(db: Awaited<ReturnType<typeof newNodeDuckDb>>) {
    const indexer = await createDuckDbIndexer({ db });
    const idx = await indexer.createIndex({ name: "schemas", subIndexes: { q: ftConfig } });
    const fts = newFullTextAccess("q").get(idx);
    await fts.addDocument([{ path: "/d/1" as DocumentPath, blockId: "a", content: "hello" }]);
    await idx.flush(); // builds the fts_main_<table> schema
    return { indexer, idx };
  }

  it("indexer.deleteIndex drops the fts_main schema", async () => {
    const db = await newNodeDuckDb();
    const { indexer } = await indexWithFts(db);
    try {
      expect(await ftsSchemas(db)).toHaveLength(1);
      await indexer.deleteIndex("schemas");
      expect(await ftsSchemas(db)).toEqual([]);
    } finally {
      await indexer.close();
    }
  });

  it("index.deleteIndex drops the fts_main schema", async () => {
    const db = await newNodeDuckDb();
    const { indexer, idx } = await indexWithFts(db);
    try {
      await idx.deleteIndex();
      expect(await ftsSchemas(db)).toEqual([]);
    } finally {
      await indexer.close();
    }
  });

  it("createIndex(overwrite) and a reinit drop the old fts_main schema", async () => {
    const db = await newNodeDuckDb();
    const { indexer, idx } = await indexWithFts(db);
    try {
      await idx.close();
      await indexer.getIndex("schemas", { subIndexes: { q: ftConfig } });
      expect(await ftsSchemas(db)).toEqual([]);
      await indexer.createIndex({ name: "schemas", subIndexes: { q: ftConfig }, overwrite: true });
      expect(await ftsSchemas(db)).toEqual([]);
    } finally {
      await indexer.close();
    }
  });
});

runSqlTableNamesSuite("DuckDB Indexer", {
  newDb: () => newNodeDuckDb(),
  closeDb: (db) => db.close(),
  createIndexer: (db) => createDuckDbIndexer({ db }),
  createLegacyIndexer: (db) =>
    createSqlIndexer({
      db: wrapDbAsSqlDb(db),
      dialect: duckdbDialect,
      tableNaming: legacySqlTableNaming,
    }),
  dropTable: async (db, table) => {
    await db.query(`DROP TABLE ${table}`);
  },
  fullTextConfig: ftConfig,
  vectorConfig: vecConfig,
});

// =============================================================================
// N-gram (grep) sub-index: the backend-agnostic contract plus the SQL specifics.
// =============================================================================

runNgramConformanceSuite("DuckDB n-gram", {
  factory: inMemFactory,
  config: { type: "ngram" },
});

runSqlNgramSuite("DuckDB n-gram", {
  factory: inMemFactory,
  store: "scan",
  foreignStore: "gin",
});

describe("DuckDB n-gram — candidate budget", () => {
  it("stops after the budget and reports truncation", async () => {
    const raw = await newNodeDuckDb();
    const db = wrapDbAsSqlDb(raw);
    try {
      for (const stmt of duckdbDialect.docsTableDdl("bud")) await db.exec(stmt);
      const ngram = defined(duckdbDialect.ngram);
      const make = (candidateBudget: number) =>
        createSqlNgramRetriever({
          db,
          prefix: "bud_g",
          docsTable: sqlDocsTableName("bud"),
          config: {},
          dialect: ngram,
          candidateBudget,
        });
      const sub = make(2);
      await sub.init();
      for (const id of ["1", "2", "3"]) {
        await sub.addDocument([
          { path: `/b/${id}` as DocumentPath, blockId: id, content: "needle" },
        ]);
      }
      const cut = await collectWithSummary(sub.search({ pattern: "needle" }));
      expect(cut.hits.map((h) => h.blockId)).toEqual(["1", "2"]);
      expect(cut.truncated).toBe(true);
      // A pattern with no usable literal scans, within the same budget.
      const scan = await collectWithSummary(sub.search({ pattern: "e+", regex: true }));
      expect(scan.hits).toHaveLength(2);
      expect(scan.truncated).toBe(true);
      const whole = await collectWithSummary(make(3).search({ pattern: "needle" }));
      expect(whole.hits).toHaveLength(3);
      expect(whole.truncated).toBe(false);
    } finally {
      await raw.close();
    }
  });
});

async function collectWithSummary<T, S extends { truncated: boolean } | undefined>(
  it: AsyncGenerator<T, S>,
): Promise<{ hits: T[]; truncated: boolean }> {
  const hits: T[] = [];
  for (;;) {
    const step = await it.next();
    if (step.done) return { hits, truncated: step.value?.truncated ?? false };
    hits.push(step.value);
  }
}

// =============================================================================
// Orphan sweep with a provider missing (statewalker-search#90).
// =============================================================================

runSqlOrphanSweepSuite("DuckDB Indexer", {
  newDb: () => newNodeDuckDb(),
  closeDb: (db) => db.close(),
  createIndexer: (db, { ngram }) =>
    createSqlIndexer({
      db: wrapDbAsSqlDb(db),
      dialect: ngram ? duckdbDialect : { ...duckdbDialect, ngram: undefined },
    }),
  query: (db, sql) => db.query(sql),
  recordsDocTables: true,
  countDocRows: async (db, indexName) => {
    const rows = await db.query<{ cnt: number | bigint }>(
      `SELECT COUNT(*) AS cnt FROM ${sqlDocsTableName(sqlTableNaming.indexPrefix(indexName))}`,
    );
    return Number(rows[0]?.cnt ?? 0);
  },
});
