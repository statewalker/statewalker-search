// =============================================================================
// createSqlIndexer — the SQL Indexer for DuckDB and PGlite.
//
// The lifecycle (manifest, load actions, delete and close rules) is the shared
// SQL kernel (`createSqlKernelIndexer`, the one SQLite uses too). This module
// supplies the storage those databases share: a per-Index docs table mapping
// paths to integer doc ids, referenced by every sub-index table and reclaimed
// after deletes, and the full-text and vector providers built from the
// backend's dialect. Each sub-index gets its own tables, named
// `idx_<subPrefix>_(fts|vec)` (`sql-table-names.ts`); tables created by earlier
// versions under the old names are still found.
// =============================================================================

import type { Indexer, ScoredHit, SearchIndex } from "@statewalker/indexer-api";
import type { FullTextConfig, FullTextIndexInfo } from "@statewalker/indexer-fulltext";
import { FULL_TEXT_TYPE } from "@statewalker/indexer-fulltext";
import type { NgramConfig } from "@statewalker/indexer-ngram";
import { NGRAM_TYPE } from "@statewalker/indexer-ngram";
import type { VectorConfig, VectorIndexInfo } from "@statewalker/indexer-vector";
import { VECTOR_TYPE } from "@statewalker/indexer-vector";
import type { SqlFtsDialect } from "./create-sql-fts-retriever.js";
import { createSqlFtsRetriever } from "./create-sql-fts-retriever.js";
import { createSqlNgramRetriever, type SqlNgramDialect } from "./create-sql-ngram-retriever.js";
import type { SqlVectorDialect } from "./create-sql-vector-retriever.js";
import { createSqlVectorRetriever } from "./create-sql-vector-retriever.js";
import type { SubIndexSpec } from "./load-actions.js";
import type { SqlDb } from "./sql-db.js";
import {
  createSqlKernelIndexer,
  type SavedIndex,
  type SqlKernelStorage,
  type SqlModalityProvider,
} from "./sql-kernel.js";
import {
  legacySqlTableNaming,
  type SqlTableNaming,
  sqlDocsTableName,
  sqlFtsTableName,
  sqlNgramTableName,
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
  /** The n-gram (grep) candidate store; when set, the indexer registers the `ngram` modality. */
  ngram?: SqlNgramDialect;
}

export interface SqlIndexerOptions {
  db: SqlDb;
  dialect: SqlBackedDialect;
  /**
   * More modalities, over the same docs table (e.g. n-gram). The dialect's full-text and vector
   * providers are always registered; a provider here with the same `type` replaces one of them.
   */
  // biome-ignore lint/suspicious/noExplicitAny: providers take their own config types
  providers?: SqlDocsModalityProvider<any>[];
  /** Optional finaliser invoked by `indexer.close()` — backends that own their `db` close it here. */
  onClose?(): Promise<void>;
  /**
   * The naming scheme for new tables. Defaults to `sqlTableNaming`; tables an earlier version
   * created under `legacySqlTableNaming` are still found. Tests pass `legacySqlTableNaming` to
   * write a database the way earlier versions did.
   */
  tableNaming?: SqlTableNaming;
}

/** The context of one sub-index over a docs-table backend. */
export interface SqlDocsContext {
  db: SqlDb;
  /** The sub-index's table prefix (`sql-table-names.ts`): its tables are `idx_<prefix>_…`. */
  prefix: string;
  /** The Index's docs table (`doc_id`, `path`), which the sub-index's rows reference. */
  docsTable: string;
}

/** A modality over a docs-table backend (DuckDB, PGlite). */
export interface SqlDocsModalityProvider<C = Record<string, unknown>>
  extends SqlModalityProvider<SqlDocsContext, C, SearchIndex<unknown, unknown, ScoredHit>> {
  /**
   * The tables of a sub-index at `ctx` whose `doc_id` column references the docs table; the
   * first one exists whenever the sub-index does. Used to reclaim orphaned doc rows, and to find
   * tables created under an earlier naming scheme.
   */
  docTables(ctx: SqlDocsContext): string[];
}

/** The docs table of one Index. */
interface DocsTable {
  /** The Index's table prefix (`idx_<prefix>_docs`). */
  prefix: string;
  table: string;
}

const MANIFEST_TABLE = "__indexer_manifest";

/**
 * The manifest field value marking an Index created under the current naming scheme
 * (`"tableNaming": 2`). Absent on Indexes created by earlier versions.
 */
const CURRENT_TABLE_NAMING = 2;

/** Postgres folds unquoted identifiers to lower case and cuts them to 63 bytes; DuckDB folds. */
function identifierKey(identifier: string): string {
  return identifier.toLowerCase().slice(0, 63);
}

/** The full-text provider over a dialect's `fts` part. */
function ftsProvider(dialect: SqlFtsDialect): SqlDocsModalityProvider<FullTextConfig> {
  return {
    type: FULL_TEXT_TYPE,
    docTables: (ctx) => [sqlFtsTableName(ctx.prefix)],
    async open({ db, prefix, docsTable }, config) {
      const info: FullTextIndexInfo = { language: config.language, metadata: config.metadata };
      const retriever = createSqlFtsRetriever({ db, prefix, docsTable, info, dialect });
      await retriever.init();
      return retriever;
    },
    async drop({ db, prefix }) {
      const tableName = sqlFtsTableName(prefix);
      if (dialect.drop) await dialect.drop({ db, tableName });
      await db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    },
  };
}

/** The vector provider over a dialect's `vec` part. */
function vectorProvider(dialect: SqlVectorDialect): SqlDocsModalityProvider<VectorConfig> {
  return {
    type: VECTOR_TYPE,
    docTables: (ctx) => [sqlVectorTableName(ctx.prefix)],
    async open({ db, prefix, docsTable }, config) {
      const info: VectorIndexInfo = {
        dimensionality: config.dimensionality,
        model: config.model,
        metadata: config.metadata,
      };
      const retriever = createSqlVectorRetriever({ db, prefix, docsTable, info, dialect });
      await retriever.init();
      return retriever;
    },
    async drop({ db, prefix }) {
      await db.exec(`DROP INDEX IF EXISTS ${sqlVectorIndexName(prefix)}`);
      await db.exec(`DROP TABLE IF EXISTS ${sqlVectorTableName(prefix)}`);
    },
  };
}

/** The n-gram provider over a dialect's `ngram` part. */
function ngramProvider(dialect: SqlNgramDialect): SqlDocsModalityProvider<NgramConfig> {
  return {
    type: NGRAM_TYPE,
    docTables: (ctx) => [sqlNgramTableName(ctx.prefix)],
    async open({ db, prefix, docsTable }, config) {
      const retriever = createSqlNgramRetriever({ db, prefix, docsTable, config, dialect });
      await retriever.init();
      return retriever;
    },
    async drop({ db, prefix }) {
      await db.exec(`DROP TABLE IF EXISTS ${sqlNgramTableName(prefix)}`);
    },
  };
}

export async function createSqlIndexer(opts: SqlIndexerOptions): Promise<Indexer> {
  const { db, dialect, onClose } = opts;
  const naming = opts.tableNaming ?? sqlTableNaming;
  // The earlier versions' scheme, to find the tables they created (none when writing under it).
  const legacy = naming === legacySqlTableNaming ? undefined : legacySqlTableNaming;
  const providers = new Map<string, SqlDocsModalityProvider>();
  for (const p of [
    ftsProvider(dialect.fts),
    vectorProvider(dialect.vec),
    ...(dialect.ngram ? [ngramProvider(dialect.ngram)] : []),
    ...(opts.providers ?? []),
  ]) {
    providers.set(p.type, p as SqlDocsModalityProvider);
  }

  for (const stmt of dialect.extensionInit) await db.exec(stmt);
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${MANIFEST_TABLE} (name TEXT PRIMARY KEY, config TEXT NOT NULL)`,
  );

  /**
   * The earlier scheme to fall back to for an Index's tables: only for an Index in the manifest
   * created by an earlier version. An Index marked as created under the current scheme never
   * falls back, since an earlier name can fold onto another Index's table (`idx_Notes_q_fts` is
   * `notes`'s table).
   */
  function earlierNaming(saved: SavedIndex | undefined): SqlTableNaming | undefined {
    if (saved === undefined || saved.tableNaming === CURRENT_TABLE_NAMING) return undefined;
    return legacy;
  }

  async function tableExists(table: string): Promise<boolean> {
    try {
      await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The current prefix, unless only the earlier versions' prefix has its table: then that one, so
   * databases written by earlier versions keep opening (no data is moved).
   */
  async function resolvePrefix(
    current: string,
    earlier: string | undefined,
    tableOf: (prefix: string) => string | undefined,
  ): Promise<string> {
    if (earlier === undefined || earlier === current) return current;
    const currentTable = tableOf(current);
    const earlierTable = tableOf(earlier);
    if (currentTable === undefined || earlierTable === undefined) return current;
    if (await tableExists(currentTable)) return current;
    if (await tableExists(earlierTable)) return earlier;
    return current;
  }

  /** The first doc-referencing table of a sub-index of `type` at `prefix`, if it has a provider. */
  function firstDocTable(type: string, prefix: string, docsTable: string): string | undefined {
    return providers.get(type)?.docTables({ db, prefix, docsTable })[0];
  }

  const storage: SqlKernelStorage<DocsTable, SqlDocsContext> = {
    readManifest: () =>
      db.query<{ name: string; config: string }>(`SELECT name, config FROM ${MANIFEST_TABLE}`),

    async writeManifest(name, config) {
      await db.query(
        `INSERT INTO ${MANIFEST_TABLE} (name, config) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET config = excluded.config`,
        [name, config],
      );
    },

    async deleteManifest(name) {
      await db.query(`DELETE FROM ${MANIFEST_TABLE} WHERE name = $1`, [name]);
    },

    async openShared(name, saved) {
      const prefix = await resolvePrefix(
        naming.indexPrefix(name),
        earlierNaming(saved)?.indexPrefix(name),
        sqlDocsTableName,
      );
      for (const stmt of dialect.docsTableDdl(prefix)) await db.exec(stmt);
      return { prefix, table: sqlDocsTableName(prefix) };
    },

    async dropShared(_name, docs) {
      await db.exec(`DROP TABLE IF EXISTS ${docs.table}`);
      if (dialect.extraCleanup) {
        for (const stmt of dialect.extraCleanup(docs.prefix)) await db.exec(stmt);
      }
    },

    async subContext(name, subName, type, docs, saved) {
      const prefix = await resolvePrefix(
        naming.subIndexPrefix(name, subName),
        earlierNaming(saved)?.subIndexPrefix(name, subName),
        (p) => firstDocTable(type, p, docs.table),
      );
      return { db, prefix, docsTable: docs.table };
    },

    // Marks an Index created under the current scheme, so it never falls back.
    manifestFields: () => (legacy ? { tableNaming: CURRENT_TABLE_NAMING } : {}),

    // Refuse a new Index whose tables already exist as the tables of another Index created by an
    // earlier version (whose scheme kept upper case and did not bound lengths, so `Notes` there
    // names the tables of `notes` here): sharing them would mix and later destroy both.
    async beforeCreate(name, subIndexes, others) {
      if (!legacy) return;
      const ours = new Map<string, string>();
      const own = (table: string | undefined) => {
        if (table) ours.set(identifierKey(table), table);
      };
      const docsTable = sqlDocsTableName(naming.indexPrefix(name));
      own(docsTable);
      for (const [subName, spec] of Object.entries(subIndexes)) {
        own(firstDocTable(spec.type, naming.subIndexPrefix(name, subName), docsTable));
      }
      for (const [other, otherSubs] of others) {
        const theirDocs = sqlDocsTableName(legacy.indexPrefix(other));
        const theirs = [theirDocs];
        for (const [subName, spec] of Object.entries(otherSubs as Record<string, SubIndexSpec>)) {
          const table = firstDocTable(spec.type, legacy.subIndexPrefix(other, subName), theirDocs);
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
    },

    // Recorded in each manifest entry, so the sweep counts a sub-index whose provider is missing.
    docTables: (type, ctx) => providers.get(type)?.docTables(ctx) ?? [],

    // Reclaim doc rows no sub-index table references any more. Every sub-index in the manifest
    // counts, skipped ones too: they keep their rows, which still reference their doc rows. So do
    // the sub-indexes without a provider, through their recorded tables (a recorded table that
    // no longer exists references nothing).
    async afterDelete(docs, subIndexes, recordedTables) {
      const tables: string[] = [];
      for (const { type, ctx } of subIndexes) {
        tables.push(...(providers.get(type)?.docTables(ctx) ?? []));
      }
      for (const table of recordedTables ?? []) {
        if (!tables.includes(table) && (await tableExists(table))) tables.push(table);
      }
      if (tables.length === 0) {
        await db.exec(`DELETE FROM ${docs.table}`);
        return;
      }
      const references = tables
        .map((t) => `EXISTS (SELECT 1 FROM ${t} b WHERE b.doc_id = d.doc_id)`)
        .join(" OR ");
      await db.exec(`DELETE FROM ${docs.table} d WHERE NOT (${references})`);
    },

    close: onClose,
  };

  return createSqlKernelIndexer({ storage, providers: [...providers.values()] });
}
