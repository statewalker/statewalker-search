import type { Db } from "@statewalker/db-api";
import type { Indexer } from "@statewalker/indexer-api";
import { createSqlKernelIndexer, type SqlKernelStorage } from "@statewalker/indexer-core";
import { type BlockIds, openBlockIds } from "./block-ids.js";
import type { SqliteModalityContext, SqliteModalityProvider } from "./types.js";

export interface SqliteIndexerOptions {
  /** The database. The indexer never closes it. */
  db: Db;
  /** One provider per modality type, e.g. FTS5, vector, n-gram. */
  providers: SqliteModalityProvider[];
}

const MANIFEST_TABLE = "__indexer_manifest";

/** Escapes everything but lower-case letters and digits: SQLite table names fold case, so "Docs" and "docs" must not collide. */
const sanitizePrefix = (name: string) =>
  name.replace(/[^a-z0-9]/g, (ch) => `_${ch.charCodeAt(0)}_`);

const indexPrefix = (name: string) => `idx_${sanitizePrefix(name)}__`;

/**
 * `Indexer` over one SQLite `Db`: the shared SQL kernel (`createSqlKernelIndexer`) over SQLite
 * storage. Keeps a manifest row per Index, one shared `{indexPrefix}blocks` id table per Index,
 * and opens each sub-index through its provider. Search fuses sub-indexes by RRF.
 */
export async function createSqliteIndexer(options: SqliteIndexerOptions): Promise<Indexer> {
  const { db } = options;
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${MANIFEST_TABLE} (name TEXT PRIMARY KEY, config TEXT NOT NULL)`,
  );

  const storage: SqlKernelStorage<BlockIds, SqliteModalityContext> = {
    readManifest: () =>
      db.query<{ name: string; config: string }>(`SELECT name, config FROM ${MANIFEST_TABLE}`),
    async writeManifest(name, config) {
      await db.query(
        `INSERT INTO ${MANIFEST_TABLE} (name, config) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET config = excluded.config`,
        [name, config],
      );
    },
    async deleteManifest(name) {
      await db.query(`DELETE FROM ${MANIFEST_TABLE} WHERE name = ?`, [name]);
    },
    openShared: (name) => openBlockIds(db, `${indexPrefix(name)}blocks`),
    async dropShared(_name, blockIds) {
      await db.exec(`DROP TABLE IF EXISTS ${blockIds.table}`);
    },
    // SQLite table names have always escaped upper case and have no length limit, so there is
    // no earlier naming scheme to fall back to.
    async subContext(name, subName, _type, blockIds) {
      return { db, prefix: `${indexPrefix(name)}${sanitizePrefix(subName)}_`, blockIds };
    },
  };

  return createSqlKernelIndexer({ storage, providers: options.providers });
}
