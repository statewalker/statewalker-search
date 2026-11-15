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
// `idx_<subPrefix>_(fts|vec)` (`sql-table-names.ts`). All share the same per-Index
// docs table for FK reclamation.
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
  Metadata,
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
import type { SqlDb } from "./sql-db.js";
import {
  legacySqlTableNaming,
  type SqlTableNaming,
  sqlDocsTableName,
  sqlFtsTableName,
  sqlTableNaming,
  sqlVectorIndexName,
  sqlVectorTableName,
} from "./sql-table-names.js";

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
  /**
   * The naming scheme for new tables. Defaults to `sqlTableNaming`; tables an earlier version
   * created under `legacySqlTableNaming` are still found. Tests pass `legacySqlTableNaming` to
   * write a database the way earlier versions did.
   */
  tableNaming?: SqlTableNaming;
}

/** The resolved table prefixes of one Index: its own and those of its sub-indexes. */
interface IndexTables {
  prefix: string;
  docsTable: string;
  /** Sub-index name -> table prefix, for sub-indexes of a known type. */
  subPrefixes: Map<string, string>;
}

/** Postgres folds unquoted identifiers to lower case and cuts them to 63 bytes; DuckDB folds. */
function identifierKey(identifier: string): string {
  return identifier.toLowerCase().slice(0, 63);
}

/** Persisted manifest entry for one Index. */
interface IndexManifest {
  /** Per-sub-index spec keyed by sub-index name; each carries `type` discriminator + config. */
  subIndexes: Record<string, { type: string } & Record<string, unknown>>;
  /** Index-level metadata from `createIndex` (absent in manifests written before it was saved). */
  metadata?: Metadata;
}

const MANIFEST_TABLE = "__indexer_manifest";

export async function createSqlIndexer(opts: SqlIndexerOptions): Promise<Indexer> {
  const { db, dialect, onClose } = opts;
  const naming = opts.tableNaming ?? sqlTableNaming;
  // The earlier versions' scheme, to find the tables they created (none when writing under it).
  const legacy = naming === legacySqlTableNaming ? undefined : legacySqlTableNaming;
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

  async function tableExists(table: string): Promise<boolean> {
    try {
      await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }

  /** The table of a sub-index of a known type, or undefined for other types. */
  function subIndexTable(type: string, subPrefix: string): string | undefined {
    if (type === FULL_TEXT_TYPE) return sqlFtsTableName(subPrefix);
    if (type === VECTOR_TYPE) return sqlVectorTableName(subPrefix);
    return undefined;
  }

  /**
   * The current prefix, unless only the earlier versions' prefix has its table: then that one, so
   * databases written by earlier versions keep opening (no data is moved).
   */
  async function resolvePrefix(
    current: string,
    earlier: string | undefined,
    tableOf: (prefix: string) => string,
  ): Promise<string> {
    if (earlier === undefined || earlier === current) return current;
    if (await tableExists(tableOf(current))) return current;
    if (await tableExists(tableOf(earlier))) return earlier;
    return current;
  }

  /** The prefixes of an existing Index's tables, under whichever scheme created them. */
  async function resolveTables(
    name: string,
    subIndexes: Record<string, { type: string } & Record<string, unknown>>,
  ): Promise<IndexTables> {
    const prefix = await resolvePrefix(
      naming.indexPrefix(name),
      legacy?.indexPrefix(name),
      sqlDocsTableName,
    );
    const subPrefixes = new Map<string, string>();
    for (const [subName, spec] of Object.entries(subIndexes)) {
      if (spec.type !== FULL_TEXT_TYPE && spec.type !== VECTOR_TYPE) continue;
      const sp = await resolvePrefix(
        naming.subIndexPrefix(name, subName),
        legacy?.subIndexPrefix(name, subName),
        (p) => subIndexTable(spec.type, p) as string,
      );
      subPrefixes.set(subName, sp);
    }
    return { prefix, docsTable: sqlDocsTableName(prefix), subPrefixes };
  }

  /**
   * Refuse a new Index whose tables already exist as the tables of another Index created by an
   * earlier version (whose scheme kept upper case and did not bound lengths, so `Notes` there
   * names the tables of `notes` here): sharing them would mix and later destroy both.
   */
  async function assertNoEarlierVersionCollision(
    name: string,
    subIndexes: Record<string, { type: string } & Record<string, unknown>>,
  ): Promise<void> {
    if (!legacy) return;
    const ours = new Map<string, string>();
    const own = (table: string) => ours.set(identifierKey(table), table);
    own(sqlDocsTableName(naming.indexPrefix(name)));
    for (const [subName, spec] of Object.entries(subIndexes)) {
      const table = subIndexTable(spec.type, naming.subIndexPrefix(name, subName));
      if (table) own(table);
    }
    for (const [other, entry] of manifest) {
      if (other === name) continue;
      const theirs = [sqlDocsTableName(legacy.indexPrefix(other))];
      for (const [subName, spec] of Object.entries(entry.subIndexes)) {
        const table = subIndexTable(spec.type, legacy.subIndexPrefix(other, subName));
        if (table) theirs.push(table);
      }
      for (const table of theirs) {
        const mine = ours.get(identifierKey(table));
        if (mine && (await tableExists(mine))) {
          throw new Error(
            `Cannot create index "${name}": its table ${mine} is already used by index "${other}", created by an earlier version whose table names fold upper case and cut long names. Delete or rename "${other}" first.`,
          );
        }
      }
    }
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
    return sqlDocsTableName(prefix);
  }

  async function dropSubIndexTables(sp: string, spec: { type: string }): Promise<void> {
    if (spec.type === FULL_TEXT_TYPE) {
      const tableName = sqlFtsTableName(sp);
      if (dialect.fts.drop) await dialect.fts.drop({ db, tableName });
      await db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    } else if (spec.type === VECTOR_TYPE) {
      await db.exec(`DROP INDEX IF EXISTS ${sqlVectorIndexName(sp)}`);
      await db.exec(`DROP TABLE IF EXISTS ${sqlVectorTableName(sp)}`);
    }
  }

  async function dropIndexTables(
    tables: IndexTables,
    subEntries: Record<string, { type: string } & Record<string, unknown>>,
  ): Promise<void> {
    // Drop each sub-index's table first, then the shared docs table, then any extras.
    for (const [subName, spec] of Object.entries(subEntries)) {
      const sp = tables.subPrefixes.get(subName);
      if (sp !== undefined) await dropSubIndexTables(sp, spec);
    }
    await db.exec(`DROP TABLE IF EXISTS ${tables.docsTable}`);
    if (dialect.extraCleanup) {
      for (const stmt of dialect.extraCleanup(tables.prefix)) await db.exec(stmt);
    }
  }

  /**
   * Build the bindings for an Index from its manifest subIndexes spec. `options` carries the load
   * actions of the getIndex flow. `tables.subPrefixes` holds the resolved prefixes of existing
   * sub-indexes; new and reinitialised ones get the current scheme's prefix, recorded there.
   */
  async function buildBindings(
    name: string,
    tables: IndexTables,
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
      const savedPrefix = tables.subPrefixes.get(subName);
      if (reinit && savedPrefix !== undefined) await dropSubIndexTables(savedPrefix, savedSpec);

      const sp =
        reinit || savedPrefix === undefined ? naming.subIndexPrefix(name, subName) : savedPrefix;
      tables.subPrefixes.set(subName, sp);
      const docsTable = tables.docsTable;
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

  /** The tables of the sub-indexes of known types in a manifest spec. */
  function subIndexTables(
    tables: IndexTables,
    subIndexes: Record<string, { type: string } & Record<string, unknown>>,
  ): string[] {
    const result: string[] = [];
    for (const [subName, spec] of Object.entries(subIndexes)) {
      const sp = tables.subPrefixes.get(subName);
      const table = sp === undefined ? undefined : subIndexTable(spec.type, sp);
      if (table) result.push(table);
    }
    return result;
  }

  /** Drop every table of an Index named in its manifest entry, and the entry itself. */
  async function deleteIndexData(name: string): Promise<void> {
    const subIndexes = manifest.get(name)?.subIndexes ?? {};
    await dropIndexTables(await resolveTables(name, subIndexes), subIndexes);
    await db.query(`DELETE FROM ${MANIFEST_TABLE} WHERE name = $1`, [name]);
    manifest.delete(name);
  }

  function buildCompositeWithHooks(
    name: string,
    tables: IndexTables,
    bindings: AnySubIndexBinding[],
    metadata: Metadata | undefined,
  ): Index {
    const index: Index = createCompositeIndex({
      name,
      metadata,
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
        // more. Enumerate the tables of every sub-index in the manifest, not only
        // the open bindings: a sub-index skipped at open (or under "warn") keeps
        // its rows, which still reference their doc rows.
        const subTables = subIndexTables(tables, manifest.get(name)?.subIndexes ?? {});
        const docsTable = tables.docsTable;
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
      return [...manifest.entries()].map(([name, entry]) =>
        entry.metadata !== undefined ? { name, metadata: entry.metadata } : { name },
      );
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

        await assertNoEarlierVersionCollision(name, subIndexes);
        const prefix = naming.indexPrefix(name);
        const tables: IndexTables = {
          prefix,
          docsTable: await createDocsTable(prefix),
          subPrefixes: new Map(),
        };

        const { bindings, effectiveSpec } = await buildBindings(name, tables, subIndexes);

        const entry: IndexManifest = {
          subIndexes: effectiveSpec,
          ...(metadata !== undefined ? { metadata } : {}),
        };
        await db.query(`INSERT INTO ${MANIFEST_TABLE} (name, config) VALUES ($1, $2)`, [
          name,
          JSON.stringify(entry),
        ]);

        const index = buildCompositeWithHooks(name, tables, bindings, metadata);
        indexes.set(name, index);
        manifest.set(name, entry);
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

        const tables = await resolveTables(name, entry.subIndexes);
        await createDocsTable(tables.prefix);

        const { bindings, effectiveSpec } = await buildBindings(
          name,
          tables,
          entry.subIndexes,
          options,
        );

        // If load actions changed the spec (reinit), persist the new spec.
        if (JSON.stringify(effectiveSpec) !== JSON.stringify(entry.subIndexes)) {
          const updated: IndexManifest = { ...entry, subIndexes: effectiveSpec };
          manifest.set(name, updated);
          await db.query(`UPDATE ${MANIFEST_TABLE} SET config = $1 WHERE name = $2`, [
            JSON.stringify(updated),
            name,
          ]);
        }

        const index = buildCompositeWithHooks(name, tables, bindings, entry.metadata);
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
