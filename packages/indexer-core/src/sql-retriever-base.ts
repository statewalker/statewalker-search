// Internal (not exported from the package): the block-table operations shared by the SQL
// full-text and vector retrievers. Both store one row per block in `tableName`
// `(doc_id, block_id, ...)`, keyed to the per-Index docs table `docsTable` `(doc_id, path)`.

import type { BlockReference, DocumentPath, PathSelector } from "@statewalker/indexer-api";
import { toAsyncIterable } from "./async.js";
import type { SqlDb } from "./sql-db.js";
import { buildPathPrefixSql } from "./sql-path-prefix.js";

export interface SqlBlockTableOptions {
  db: SqlDb;
  tableName: string;
  docsTable: string;
  /** Throws when the retriever is closed; called first by every public operation below. */
  ensureOpen(): void;
}

export interface SqlBlockTable {
  /** The doc_id of `path` in the docs table, inserting the path if it is new (-1 if none came back). */
  resolveDocId(path: DocumentPath): Promise<number>;
  /** Rows `SELECT <columns>` from the block table joined to the docs table (`b`, `d`), under a path prefix. */
  selectBlocks<T>(columns: string, pathPrefix?: DocumentPath): Promise<T[]>;
  deleteDocuments(pathSelectors: PathSelector[] | AsyncIterable<PathSelector>): Promise<void>;
  getSize(pathPrefix?: DocumentPath): Promise<number>;
  getDocumentPaths(pathPrefix?: DocumentPath): AsyncGenerator<DocumentPath>;
  getDocumentBlocksRefs(pathPrefix?: DocumentPath): AsyncGenerator<BlockReference>;
}

export function createSqlBlockTable(opts: SqlBlockTableOptions): SqlBlockTable {
  const { db, tableName, docsTable, ensureOpen } = opts;
  const join = `FROM ${tableName} b JOIN ${docsTable} d ON d.doc_id = b.doc_id`;

  const selectBlocks = async <T>(columns: string, pathPrefix?: DocumentPath): Promise<T[]> => {
    const cond = pathPrefix !== undefined ? buildPathPrefixSql("d.path", pathPrefix, 1) : null;
    const sql = cond ? `SELECT ${columns} ${join} WHERE ${cond.sql}` : `SELECT ${columns} ${join}`;
    return db.query<T>(sql, cond?.params ?? []);
  };

  return {
    async resolveDocId(path: DocumentPath): Promise<number> {
      await db.query(`INSERT INTO ${docsTable} (path) VALUES ($1) ON CONFLICT (path) DO NOTHING`, [
        path,
      ]);
      const rows = await db.query<{ doc_id: number }>(
        `SELECT doc_id FROM ${docsTable} WHERE path = $1`,
        [path],
      );
      return rows[0]?.doc_id ?? -1;
    },

    selectBlocks,

    async deleteDocuments(
      pathSelectors: PathSelector[] | AsyncIterable<PathSelector>,
    ): Promise<void> {
      ensureOpen();
      for await (const sel of toAsyncIterable(pathSelectors)) {
        if (sel.blockId !== undefined) {
          await db.query(
            `DELETE FROM ${tableName} WHERE doc_id IN (SELECT doc_id FROM ${docsTable} WHERE path = $1) AND block_id = $2`,
            [sel.path, sel.blockId],
          );
        } else {
          const cond = buildPathPrefixSql("path", sel.path, 1);
          await db.query(
            `DELETE FROM ${tableName} WHERE doc_id IN (SELECT doc_id FROM ${docsTable} WHERE ${cond.sql})`,
            cond.params,
          );
        }
      }
    },

    async getSize(pathPrefix?: DocumentPath): Promise<number> {
      ensureOpen();
      if (pathPrefix !== undefined) {
        const rows = await selectBlocks<{ cnt: number | bigint }>("COUNT(*) AS cnt", pathPrefix);
        return Number(rows[0]?.cnt ?? 0);
      }
      const rows = await db.query<{ cnt: number | bigint }>(
        `SELECT COUNT(*) AS cnt FROM ${tableName}`,
      );
      return Number(rows[0]?.cnt ?? 0);
    },

    async *getDocumentPaths(pathPrefix?: DocumentPath): AsyncGenerator<DocumentPath> {
      ensureOpen();
      const rows = await selectBlocks<{ path: string }>("DISTINCT d.path", pathPrefix);
      for (const row of rows) yield row.path as DocumentPath;
    },

    async *getDocumentBlocksRefs(pathPrefix?: DocumentPath): AsyncGenerator<BlockReference> {
      ensureOpen();
      const rows = await selectBlocks<{ path: string; block_id: string }>(
        "d.path, b.block_id",
        pathPrefix,
      );
      for (const row of rows) {
        yield { path: row.path as DocumentPath, blockId: row.block_id };
      }
    },
  };
}
