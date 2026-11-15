import type { DocumentPath, Metadata, PathSelector } from "@statewalker/indexer-api";
import type {
  FullTextBlock,
  FullTextIndex,
  FullTextIndexInfo,
  FulltextQuery as FullTextSearchParams,
  FulltextResult as FullTextSearchResult,
} from "@statewalker/indexer-fulltext";
import { compositeKey } from "./composite-key.js";
import type { SqlDb } from "./sql-db.js";
import { createSqlBlockTable } from "./sql-retriever-base.js";
import { sqlFtsTableName } from "./sql-table-names.js";

/**
 * Per-dialect SQL hooks for a full-text sub-index.
 *
 * Only the table DDL and the search SQL differ between SQL backends; everything else (CRUD, path filters,
 * doc-id resolution, enumeration) is shared in {@link createSqlFtsRetriever}.
 */
export interface SqlFtsDialect {
  /**
   * DDL statements to create the FTS table and any auxiliary indexes. Runs once per sub-index on `init()`.
   * Each returned string is `exec()`'d in order.
   */
  createTableDdl(opts: { tableName: string; info: FullTextIndexInfo }): string[];

  /**
   * Optional hook to (re)build an external FTS index structure after ingest/delete. When set, the
   * retriever tracks a dirty flag (set on every write) and calls this lazily before `search` and on
   * `flush`. Dialects whose FTS is maintained automatically by the database (e.g. PGlite's `tsvector`)
   * leave this undefined.
   */
  rebuild?(opts: { db: SqlDb; tableName: string; info: FullTextIndexInfo }): Promise<void>;

  /**
   * Optional hook that removes the dialect's auxiliary FTS structures for a table (e.g. DuckDB's
   * `fts_main_<table>` schema). Runs before the table is dropped, by `deleteIndex` and whenever the
   * indexer drops a full-text sub-index's table.
   */
  drop?(opts: { db: SqlDb; tableName: string }): Promise<void>;

  /**
   * Execute a lexical search for a single query string. The base iterates `queries[]` and merges by best score.
   */
  search(opts: {
    db: SqlDb;
    tableName: string;
    docsTable: string;
    info: FullTextIndexInfo;
    query: string;
    paths: DocumentPath[] | undefined;
    topK: number;
  }): Promise<Array<{ path: DocumentPath; blockId: string; content: string; score: number }>>;
}

export interface SqlFtsRetrieverOptions {
  db: SqlDb;
  prefix: string;
  docsTable: string;
  info: FullTextIndexInfo;
  dialect: SqlFtsDialect;
}

/**
 * SQL-backed `FullTextIndex` implementation shared by every SQL backend. Per-dialect differences are
 * supplied via {@link SqlFtsDialect}. Callers typically expose this as `XxxFullTextIndex` in their barrel.
 */
export function createSqlFtsRetriever(opts: SqlFtsRetrieverOptions): FullTextIndex & {
  readonly tableName: string;
  init(): Promise<void>;
} {
  const { db, prefix, docsTable, info, dialect } = opts;
  const tableName = sqlFtsTableName(prefix);
  let closed = false;
  // Start dirty: forces a rebuild on first search after `init()` or a reopen, covering both
  // brand-new tables and tables whose FTS index structure may be out of date.
  let dirty = dialect.rebuild != null;

  const ensureOpen = (): void => {
    if (closed) throw new Error("FullTextIndex is closed");
  };

  const ensureRebuilt = async (): Promise<void> => {
    if (!dialect.rebuild || !dirty) return;
    await dialect.rebuild({ db, tableName, info });
    dirty = false;
  };

  const blockTable = createSqlBlockTable({ db, tableName, docsTable, ensureOpen });

  return {
    tableName,

    async init(): Promise<void> {
      for (const stmt of dialect.createTableDdl({ tableName, info })) {
        await db.exec(stmt);
      }
    },

    async getIndexInfo(): Promise<FullTextIndexInfo> {
      ensureOpen();
      return { ...info };
    },

    async *search(params: FullTextSearchParams): AsyncGenerator<FullTextSearchResult> {
      ensureOpen();
      const { queries, paths } = params;
      // Sub-queries may omit `topK` to defer to the composite's top-level cutoff;
      // for the per-stream SQL we use a generous default so RRF has material.
      const topK = params.topK ?? 100;
      if (!queries || queries.length === 0) return;

      await ensureRebuilt();

      const bestScores = new Map<string, FullTextSearchResult>();
      for (const query of queries) {
        const rows = await dialect.search({ db, tableName, docsTable, info, query, paths, topK });
        for (const row of rows) {
          const key = compositeKey(row.path, row.blockId);
          const existing = bestScores.get(key);
          if (!existing || row.score > existing.score) {
            bestScores.set(key, {
              path: row.path,
              blockId: row.blockId,
              snippet: row.content,
              score: row.score,
            });
          }
        }
      }

      const sorted = [...bestScores.values()].sort((a, b) => b.score - a.score);
      for (const r of sorted.slice(0, topK)) yield r;
    },

    async addDocument(blocks: FullTextBlock[]): Promise<void> {
      ensureOpen();
      // Mark dirty before writing: if a block fails part-way, the rows already inserted
      // still get indexed by the next rebuild.
      if (dialect.rebuild && blocks.length > 0) dirty = true;
      for (const block of blocks) {
        const docId = await blockTable.resolveDocId(block.path);
        const metaJson = block.metadata ? JSON.stringify(block.metadata) : null;
        // Single-statement UPSERT: a failed re-ingest can't strand the old row
        // the way a DELETE+INSERT pair would when the INSERT half throws.
        await db.query(
          `INSERT INTO ${tableName} (doc_id, block_id, content, metadata) VALUES ($1, $2, $3, $4) ON CONFLICT (doc_id, block_id) DO UPDATE SET content = EXCLUDED.content, metadata = EXCLUDED.metadata`,
          [docId, block.blockId, block.content, metaJson],
        );
      }
    },

    async addDocuments(
      blocks: Iterable<FullTextBlock[]> | AsyncIterable<FullTextBlock[]>,
    ): Promise<void> {
      ensureOpen();
      for await (const batch of blocks) await this.addDocument(batch);
    },

    async deleteDocuments(
      pathSelectors: PathSelector[] | AsyncIterable<PathSelector>,
    ): Promise<void> {
      await blockTable.deleteDocuments(pathSelectors);
      if (dialect.rebuild) dirty = true;
    },

    getSize: blockTable.getSize,
    getDocumentPaths: blockTable.getDocumentPaths,
    getDocumentBlocksRefs: blockTable.getDocumentBlocksRefs,

    async *getDocumentsBlocks(pathPrefix?: DocumentPath): AsyncGenerator<FullTextBlock> {
      ensureOpen();
      const rows = await blockTable.selectBlocks<{
        path: string;
        block_id: string;
        content: string;
        metadata: string | null;
      }>("d.path, b.block_id, b.content, b.metadata", pathPrefix);
      for (const row of rows) {
        yield {
          path: row.path as DocumentPath,
          blockId: row.block_id,
          content: row.content,
          metadata: row.metadata ? (JSON.parse(row.metadata) as Metadata) : undefined,
        };
      }
    },

    async close(_options?: { force?: boolean }): Promise<void> {
      closed = true;
    },

    async flush(): Promise<void> {
      ensureOpen();
      await ensureRebuilt();
    },

    async deleteIndex(): Promise<void> {
      ensureOpen();
      closed = true;
      if (dialect.drop) await dialect.drop({ db, tableName });
      await db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    },
  };
}
