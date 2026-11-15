// =============================================================================
// createSqlIndexer — open-registry Indexer for SQL backends.
//
// Generic over `SqlBackedDialect` (FTS + vector dialect aggregation). Owns the
// manifest table, per-Index docs table, and lifecycle. Dispatches each
// sub-index's `type` discriminator to the FTS or vector dialect, producing one
// `SubIndexBinding` per registered sub-index.
//
// Multi-instance: two FTS sub-indexes (or two vector sub-indexes) on one Index
// is supported; each gets its own per-sub-index table named
// `idx_<indexPrefix>_<subPrefix>_(fts|vec)`. All share the same per-Index docs
// table for FK reclamation.
//
// Not Provider-based (per D10 in the design): the shared "docs table with FK
// reclamation" pattern is SQL-specific and doesn't fit the
// `ModalityProvider.create(config)` shape. SQL backends import this helper
// instead of `createPersistenceBackedIndexer`.
// =============================================================================

import type {
  AnySubIndexBinding,
  CreateIndexParams,
  GetIndexOptions,
  Index,
  Indexer,
  IndexInfo,
} from "@statewalker/indexer-api";
import type { FullTextConfig, FullTextIndexInfo } from "@statewalker/indexer-fulltext";
import { FULL_TEXT_TYPE } from "@statewalker/indexer-fulltext";
import type { VectorConfig, VectorIndexInfo } from "@statewalker/indexer-vector";
import { VECTOR_TYPE } from "@statewalker/indexer-vector";
import { createCompositeIndex } from "./create-composite-index.js";
import type { SqlFtsDialect } from "./create-sql-fts-retriever.js";
import { createSqlFtsRetriever } from "./create-sql-fts-retriever.js";
import type { SqlVectorDialect } from "./create-sql-vector-retriever.js";
import { createSqlVectorRetriever } from "./create-sql-vector-retriever.js";
import { createSerialiser } from "./run-exclusive.js";
import { sanitizePrefix } from "./sanitize-prefix.js";
import type { SqlDb } from "./sql-db.js";

/** Per-backend dialect aggregating the pieces that genuinely differ between SQL backends. */
export interface SqlBackedDialect {
  /** SQL strings to run once during init, after the manifest table is created. */
  extensionInit: string[];
  /** DDL for the per-index docs table. Returns one or more statements. */
  docsTableDdl(prefix: string): string[];
  /** Optional per-index cleanup SQL (e.g. dropping auxiliary sequences). Runs after the docs table is dropped. */
  extraCleanup?(prefix: string): string[];
  /** Whether the backend can wrap DDL in a transaction (PGlite: yes; DuckDB: usually no for some DDL). */
  supportsDDLInTransaction?: boolean;
  /**
   * Legacy field from the prior single-modality `getSize` UNION SQL — retained
   * optional so existing dialect aggregates (`pgliteDialect`, `duckdbDialect`)
   * compile without edits. The open-registry composite no longer issues this
   * union; the field is unused by `createSqlIndexer`.
   */
  unionAliasSuffix?: string;
  fts: SqlFtsDialect;
  vec: SqlVectorDialect;
}

export interface SqlIndexerOptions {
  db: SqlDb;
  dialect: SqlBackedDialect;
  /** Optional finaliser invoked by `indexer.close()` — backends that own their `db` close it here. */
  onClose?(): Promise<void>;
}

/** Persisted manifest entry for one Index. */
interface IndexManifest {
  /** Per-sub-index spec keyed by sub-index name; each carries `type` discriminator + config. */
  subIndexes: Record<string, { type: string } & Record<string, unknown>>;
}

const MANIFEST_TABLE = "__indexer_manifest";

/** Build a stable per-sub-index prefix string suitable for SQL identifiers. */
function subPrefix(indexPrefix: string, subName: string): string {
  return `${indexPrefix}_${sanitizePrefix(subName)}`;
}

export async function createSqlIndexer(opts: SqlIndexerOptions): Promise<Indexer> {
  const { db, dialect, onClose } = opts;
  const indexes = new Map<string, Index>();
  const manifest = new Map<string, IndexManifest>();
  const runExclusive = createSerialiser();
  let closed = false;

  for (const stmt of dialect.extensionInit) await db.exec(stmt);

  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${MANIFEST_TABLE} (name TEXT PRIMARY KEY, config TEXT NOT NULL)`,
  );

  // Hydrate in-memory manifest from the table.
  const rows = await db.query<{ name: string; config: string }>(
    `SELECT name, config FROM ${MANIFEST_TABLE}`,
  );
  for (const row of rows) {
    try {
      manifest.set(row.name, JSON.parse(row.config) as IndexManifest);
    } catch {
      // Skip rows with malformed config — caller can re-create the Index.
    }
  }

  function ensureOpen(): void {
    if (closed) throw new Error("Indexer is closed");
  }

  /** Evict and close the open instance of an Index, if any. */
  async function closeLive(name: string): Promise<void> {
    const live = indexes.get(name);
    if (!live) return;
    indexes.delete(name);
    try {
      await live.close();
    } catch {
      /* already closed or failing to close: the tables are dropped anyway */
    }
  }

  async function createDocsTable(prefix: string): Promise<string> {
    for (const stmt of dialect.docsTableDdl(prefix)) await db.exec(stmt);
    return `idx_${prefix}_docs`;
  }

  async function dropSubIndexTables(
    indexPrefix: string,
    subName: string,
    spec: { type: string },
  ): Promise<void> {
    const sp = subPrefix(indexPrefix, subName);
    if (spec.type === FULL_TEXT_TYPE) {
      if (dialect.fts.drop) await dialect.fts.drop({ db, tableName: `idx_${sp}_fts` });
      await db.exec(`DROP TABLE IF EXISTS idx_${sp}_fts`);
    } else if (spec.type === VECTOR_TYPE) {
      await db.exec(`DROP INDEX IF EXISTS idx_${sp}_vec_hnsw`);
      await db.exec(`DROP TABLE IF EXISTS idx_${sp}_vec`);
    }
  }

  async function dropIndexTables(
    indexPrefix: string,
    subEntries: Record<string, { type: string } & Record<string, unknown>>,
  ): Promise<void> {
    // Drop each sub-index's table first, then the shared docs table, then any extras.
    for (const [subName, spec] of Object.entries(subEntries)) {
      await dropSubIndexTables(indexPrefix, subName, spec);
    }
    await db.exec(`DROP TABLE IF EXISTS idx_${indexPrefix}_docs`);
    if (dialect.extraCleanup) {
      for (const stmt of dialect.extraCleanup(indexPrefix)) await db.exec(stmt);
    }
  }

  /**
   * Build the bindings for an Index from its manifest subIndexes spec.
   * `applyLoadActions` switches between createIndex flow and getIndex flow.
   */
  async function buildBindings(
    indexPrefix: string,
    docsTable: string,
    subIndexes: Record<string, { type: string } & Record<string, unknown>>,
    options?: GetIndexOptions,
  ): Promise<{
    bindings: AnySubIndexBinding[];
    effectiveSpec: Record<string, { type: string } & Record<string, unknown>>;
  }> {
    const onMissing: "throw" | "warn" = options?.onMissingProvider ?? "throw";
    const optActions = options?.subIndexes;

    const bindings: AnySubIndexBinding[] = [];
    const effectiveSpec: Record<string, { type: string } & Record<string, unknown>> = {};
    const knownTypes = [FULL_TEXT_TYPE, VECTOR_TYPE];
    const missingTypeError = (subName: string, type: string) =>
      new Error(
        `Cannot load index: sub-index "${subName}" requires modality "${type}" but only [${knownTypes
          .map((t) => `"${t}"`)
          .join(", ")}] are registered.`,
      );

    // Under "throw", fail before any reinit drops a table.
    if (onMissing === "throw") {
      for (const [subName, savedSpec] of Object.entries(subIndexes)) {
        const action = optActions?.[subName];
        if (action && "skip" in action) continue;
        const type = action ? action.type : savedSpec.type;
        if (!knownTypes.includes(type as typeof FULL_TEXT_TYPE)) {
          throw missingTypeError(subName, type);
        }
      }
    }

    for (const [subName, savedSpec] of Object.entries(subIndexes)) {
      const action = optActions?.[subName];
      if (action && "skip" in action && action.skip === true) {
        // Preserve the saved spec in the manifest; don't register a binding.
        effectiveSpec[subName] = savedSpec;
        continue;
      }

      const reinit = action !== undefined && !("skip" in action);
      const { type: effType, ...effConfig } = reinit ? action : savedSpec;

      // Check the type before touching any table: an unsupported reinit must not drop data.
      if (!knownTypes.includes(effType as typeof FULL_TEXT_TYPE)) {
        if (onMissing === "throw") throw missingTypeError(subName, effType);
        const g = globalThis as { console?: { warn(...args: unknown[]): void } };
        g.console?.warn(
          `Sub-index "${subName}" (type "${effType}") has no matching dialect; skipping.`,
        );
        effectiveSpec[subName] = savedSpec;
        continue;
      }

      // Reinit: drop the existing tables for this sub-index; they are recreated below.
      if (reinit) await dropSubIndexTables(indexPrefix, subName, savedSpec);

      const sp = subPrefix(indexPrefix, subName);
      effectiveSpec[subName] = { type: effType, ...effConfig };

      if (effType === FULL_TEXT_TYPE) {
        const cfg = effConfig as unknown as FullTextConfig;
        const info: FullTextIndexInfo = { language: cfg.language, metadata: cfg.metadata };
        const retriever = createSqlFtsRetriever({
          db,
          prefix: sp,
          docsTable,
          info,
          dialect: dialect.fts,
        });
        await retriever.init();
        bindings.push({
          name: subName,
          type: FULL_TEXT_TYPE,
          config: effConfig,
          index: retriever,
        });
      } else {
        const cfg = effConfig as unknown as VectorConfig;
        const info: VectorIndexInfo = {
          dimensionality: cfg.dimensionality,
          model: cfg.model,
          metadata: cfg.metadata,
        };
        const retriever = createSqlVectorRetriever({
          db,
          prefix: sp,
          docsTable,
          info,
          dialect: dialect.vec,
        });
        await retriever.init();
        bindings.push({
          name: subName,
          type: VECTOR_TYPE,
          config: effConfig,
          index: retriever,
        });
      }
    }

    return { bindings, effectiveSpec };
  }

  /** Drop every table of an Index named in its manifest entry, and the entry itself. */
  async function deleteIndexData(name: string): Promise<void> {
    const entry = manifest.get(name);
    await dropIndexTables(sanitizePrefix(name), entry?.subIndexes ?? {});
    await db.query(`DELETE FROM ${MANIFEST_TABLE} WHERE name = $1`, [name]);
    manifest.delete(name);
  }

  function buildCompositeWithHooks(
    name: string,
    indexPrefix: string,
    docsTable: string,
    bindings: AnySubIndexBinding[],
  ): Index {
    const index: Index = createCompositeIndex({
      name,
      bindings,
      // After the bound sub-indexes dropped their tables: drop the tables of every
      // sub-index in the manifest (skipped ones too), the docs table and the entry.
      onDeleteIndex: async () => {
        if (indexes.get(name) === index) indexes.delete(name);
        await deleteIndexData(name);
      },
      // A closed instance leaves the cache, so getIndex opens a new one.
      onClose: async () => {
        if (indexes.get(name) === index) indexes.delete(name);
      },
      // Reclaim doc rows orphaned by the per-sub-index DELETEs.
      onAfterDelete: async () => {
        // A doc is orphaned when no sub-index table references its doc_id any
        // more. Enumerate the in-memory bindings' table names; if zero
        // references remain across all of them, drop the doc row.
        const subTables = bindings.map((b) => {
          const sp = subPrefix(indexPrefix, b.name);
          return b.type === FULL_TEXT_TYPE ? `idx_${sp}_fts` : `idx_${sp}_vec`;
        });
        if (subTables.length === 0) {
          await db.exec(`DELETE FROM ${docsTable}`);
          return;
        }
        const existsClauses = subTables
          .map((t) => `EXISTS (SELECT 1 FROM ${t} b WHERE b.doc_id = d.doc_id)`)
          .join(" OR ");
        await db.exec(`DELETE FROM ${docsTable} d WHERE NOT (${existsClauses})`);
      },
    });
    return index;
  }

  return {
    async getIndexNames(): Promise<IndexInfo[]> {
      ensureOpen();
      return [...manifest.keys()].map((name) => ({ name }));
    },

    createIndex(params: CreateIndexParams): Promise<Index> {
      return runExclusive(async () => {
        ensureOpen();
        const { name, subIndexes, overwrite, metadata } = params;
        if (!subIndexes || Object.keys(subIndexes).length === 0) {
          throw new Error("Cannot create index without any subIndexes");
        }

        if (indexes.has(name) || manifest.has(name)) {
          if (!overwrite) throw new Error(`Index "${name}" already exists`);
          await closeLive(name);
          await deleteIndexData(name);
        }

        const indexPrefix = sanitizePrefix(name);
        const docsTable = await createDocsTable(indexPrefix);

        const { bindings, effectiveSpec } = await buildBindings(indexPrefix, docsTable, subIndexes);

        await db.query(`INSERT INTO ${MANIFEST_TABLE} (name, config) VALUES ($1, $2)`, [
          name,
          JSON.stringify({ subIndexes: effectiveSpec } satisfies IndexManifest),
        ]);

        const index = buildCompositeWithHooks(name, indexPrefix, docsTable, bindings);
        // Attach metadata if supplied — composite stores it.
        if (metadata !== undefined) {
          (index as { metadata?: unknown }).metadata = metadata;
        }
        indexes.set(name, index);
        manifest.set(name, { subIndexes: effectiveSpec });
        return index;
      });
    },

    getIndex(name: string, options?: GetIndexOptions): Promise<Index | null> {
      // Serialised with the other mutating calls, so concurrent first opens open once
      // (a second reinit would otherwise drop tables the first just wrote).
      return runExclusive(async () => {
        ensureOpen();
        const cached = indexes.get(name);
        if (cached) return cached;

        const entry = manifest.get(name);
        if (!entry) return null;

        const indexPrefix = sanitizePrefix(name);
        const docsTable = await createDocsTable(indexPrefix);

        const { bindings, effectiveSpec } = await buildBindings(
          indexPrefix,
          docsTable,
          entry.subIndexes,
          options,
        );

        // If load actions changed the spec (reinit), persist the new spec.
        if (JSON.stringify(effectiveSpec) !== JSON.stringify(entry.subIndexes)) {
          manifest.set(name, { subIndexes: effectiveSpec });
          await db.query(`UPDATE ${MANIFEST_TABLE} SET config = $1 WHERE name = $2`, [
            JSON.stringify({ subIndexes: effectiveSpec } satisfies IndexManifest),
            name,
          ]);
        }

        const index = buildCompositeWithHooks(name, indexPrefix, docsTable, bindings);
        indexes.set(name, index);
        return index;
      });
    },

    async hasIndex(name: string): Promise<boolean> {
      ensureOpen();
      return manifest.has(name);
    },

    deleteIndex(name: string): Promise<void> {
      return runExclusive(async () => {
        ensureOpen();
        // Close the open instance (if any), then drop every table the manifest names:
        // this works after index.close() and covers sub-indexes skipped at open.
        await closeLive(name);
        if (!manifest.has(name)) return;
        await deleteIndexData(name);
      });
    },

    flush(): Promise<void> {
      return runExclusive(async () => {
        ensureOpen();
        for (const idx of indexes.values()) await idx.flush();
      });
    },

    close(): Promise<void> {
      return runExclusive(async () => {
        if (closed) return;
        closed = true;
        for (const idx of [...indexes.values()]) {
          try {
            await idx.close();
          } catch {
            /* */
          }
        }
        indexes.clear();
        manifest.clear();
        if (onClose) await onClose();
      });
    },
  } satisfies Indexer;
}
