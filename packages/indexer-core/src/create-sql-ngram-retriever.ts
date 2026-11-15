import { fold, planQuery, trigrams } from "@statewalker/db-sqlite-index/ngram";
import type { DocumentPath, Metadata, PathSelector } from "@statewalker/indexer-api";
import type {
  NgramBlock,
  NgramConfig,
  NgramIndex,
  NgramIndexInfo,
  NgramMatch,
  NgramQuery,
  NgramResult,
  NgramSearchSummary,
} from "@statewalker/indexer-ngram";
import type { SqlDb } from "./sql-db.js";
import { buildPathPrefixesSql } from "./sql-path-prefix.js";
import { createSqlBlockTable } from "./sql-retriever-base.js";
import { sqlNgramTableName } from "./sql-table-names.js";

/**
 * Case-folds `text` per code point, as the n-gram planner folds query literals (the SQLite
 * backend's `fold`): a folded literal is a substring of the folded text whenever a
 * case-insensitive match exists, and offsets are preserved.
 */
export function foldNgramText(text: string): string {
  return fold(text);
}

/** The distinct trigrams (3 code points) of `text`, case-folded as by {@link foldNgramText}. */
export function ngramTrigrams(text: string): string[] {
  return trigrams(text);
}

/** Candidates checked per search at most, as in the SQLite backend; past it the search is truncated. */
export const SQL_NGRAM_CANDIDATE_BUDGET = 10_000;

/** Candidate rows fetched (and verified) per query. */
const PAGE = 500;

/**
 * Per-dialect candidate store of the SQL n-gram sub-index.
 *
 * Every row of the table holds `doc_id`, `block_id`, `content` and the dialect's own store
 * columns. A search plans the pattern with the SQLite backend's planner (`planQuery`), asks
 * the store for the blocks that contain every folded literal of some branch, and verifies
 * them in JavaScript, so matching semantics and offsets are the same on every backend.
 */
export interface SqlNgramDialect {
  /** The store name `getIndexInfo().store` reports, the only `store` a config may ask for. */
  store: NgramIndexInfo["store"];
  /**
   * DDL for the table and its auxiliary indexes: columns `doc_id INTEGER`, `block_id TEXT`,
   * `content TEXT`, `metadata TEXT` and the store columns, primary key `(doc_id, block_id)`.
   */
  createTableDdl(opts: { tableName: string }): string[];
  /** The store columns of a block and their values, derived from its content. */
  storeColumns(content: string): Record<string, unknown>;
  /**
   * A condition on the row alias `b` that holds for every block containing all `literals`
   * (case-folded, each at least 3 code points). It may hold for more blocks (verification
   * removes them) but never for fewer. Parameters are numbered from `$startParam`.
   */
  branchSql(literals: string[], startParam: number): { sql: string; params: unknown[] };
}

export interface SqlNgramRetrieverOptions {
  db: SqlDb;
  prefix: string;
  docsTable: string;
  config: NgramConfig;
  dialect: SqlNgramDialect;
  /** Candidates checked per search at most (default {@link SQL_NGRAM_CANDIDATE_BUDGET}). */
  candidateBudget?: number;
}

/** 1-based line of each match, from the positions of `\n` in `text`. */
function withLines(text: string, matches: { start: number; end: number }[]): NgramMatch[] {
  const breaks: number[] = [];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) breaks.push(i);
  let line = 1;
  let b = 0;
  return matches.map(({ start, end }) => {
    while (b < breaks.length && (breaks[b] as number) < start) {
      b++;
      line++;
    }
    return { start, end, line };
  });
}

/**
 * SQL-backed {@link NgramIndex} over a docs-table backend (DuckDB, PGlite). The candidate store
 * is the dialect's ({@link SqlNgramDialect}); planning, verification, ranking (score = match
 * count, ties in `(doc_id, block_id)` order), the candidate budget and `topK` are shared.
 */
export function createSqlNgramRetriever(opts: SqlNgramRetrieverOptions): NgramIndex & {
  readonly tableName: string;
  init(): Promise<void>;
} {
  const { db, prefix, docsTable, config, dialect } = opts;
  const budget = opts.candidateBudget ?? SQL_NGRAM_CANDIDATE_BUDGET;
  if (config.store !== undefined && config.store !== dialect.store) {
    throw new Error(
      `ngram: store "${config.store}" is not available on this backend (it has "${dialect.store}")`,
    );
  }
  const tableName = sqlNgramTableName(prefix);
  let closed = false;
  const ensureOpen = (): void => {
    if (closed) throw new Error("NgramIndex is closed");
  };
  const blockTable = createSqlBlockTable({ db, tableName, docsTable, ensureOpen });

  return {
    tableName,

    async init(): Promise<void> {
      for (const stmt of dialect.createTableDdl({ tableName })) await db.exec(stmt);
    },

    async getIndexInfo(): Promise<NgramIndexInfo> {
      ensureOpen();
      return { store: dialect.store, ...(config.metadata ? { metadata: config.metadata } : {}) };
    },

    async *search(params: NgramQuery): AsyncGenerator<NgramResult, NgramSearchSummary> {
      ensureOpen();
      const plan = planQuery(params.pattern, {
        regex: params.regex ?? false,
        caseSensitive: params.caseSensitive ?? true,
      });
      const limit = params.topK ?? 100;
      if (limit <= 0) return { truncated: true };

      const conditions: string[] = [];
      const queryParams: unknown[] = [];
      if (plan.branches !== null) {
        const branches = plan.branches.map((literals) => {
          const branch = dialect.branchSql(literals, queryParams.length + 1);
          queryParams.push(...branch.params);
          return `(${branch.sql})`;
        });
        conditions.push(`(${branches.join(" OR ")})`);
      }
      const scope = buildPathPrefixesSql("d.path", params.paths ?? [], queryParams.length + 1);
      if (scope.sql) {
        conditions.push(scope.sql);
        queryParams.push(...scope.params);
      }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const select = `SELECT d.path, b.block_id, b.content FROM ${tableName} b JOIN ${docsTable} d ON d.doc_id = b.doc_id${where} ORDER BY b.doc_id, b.block_id`;
      const page = (offset: number, take: number) =>
        db.query<{ path: string; block_id: string; content: string }>(
          `${select} LIMIT ${take} OFFSET ${offset}`,
          queryParams,
        );

      const hits: NgramResult[] = [];
      let truncated = false;
      scan: for (let offset = 0; ; offset += PAGE) {
        const take = Math.min(PAGE, budget + 1 - offset);
        const rows = await page(offset, take);
        for (let i = 0; i < rows.length; i++) {
          if (offset + i >= budget) {
            truncated = true;
            break scan;
          }
          const row = rows[i] as (typeof rows)[number];
          const content = String(row.content);
          const found: { start: number; end: number }[] = [];
          for (const m of content.matchAll(plan.regex)) {
            if (m[0].length > 0) found.push({ start: m.index, end: m.index + m[0].length });
          }
          if (found.length === 0) continue;
          hits.push({
            path: row.path as DocumentPath,
            blockId: row.block_id,
            score: found.length,
            count: found.length,
            matches: withLines(content, found),
          });
          if (hits.length >= limit) {
            // Truncated when any candidate is left unchecked.
            truncated = i < rows.length - 1 || (await page(offset + rows.length, 1)).length > 0;
            break scan;
          }
        }
        if (rows.length < take) break;
      }
      // Array sort is stable: equal counts keep the (doc_id, block_id) order.
      hits.sort((x, y) => y.count - x.count);
      for (const hit of hits) yield hit;
      return { truncated };
    },

    async addDocument(blocks: NgramBlock[]): Promise<void> {
      ensureOpen();
      for (const block of blocks) {
        const docId = await blockTable.resolveDocId(block.path);
        const store = dialect.storeColumns(block.content);
        const storeNames = Object.keys(store);
        const columns = ["doc_id", "block_id", "content", "metadata", ...storeNames];
        const values = [
          docId,
          block.blockId,
          block.content,
          block.metadata ? JSON.stringify(block.metadata) : null,
          ...storeNames.map((n) => store[n]),
        ];
        const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
        const updates = columns
          .slice(2)
          .map((c) => `${c} = EXCLUDED.${c}`)
          .join(", ");
        // One UPSERT per block: a failed re-ingest cannot strand the old row.
        await db.query(
          `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (doc_id, block_id) DO UPDATE SET ${updates}`,
          values,
        );
      }
    },

    async addDocuments(
      batches: Iterable<NgramBlock[]> | AsyncIterable<NgramBlock[]>,
    ): Promise<void> {
      ensureOpen();
      for await (const batch of batches) await this.addDocument(batch);
    },

    deleteDocuments(selectors: PathSelector[] | AsyncIterable<PathSelector>): Promise<void> {
      return blockTable.deleteDocuments(selectors);
    },

    getSize: blockTable.getSize,
    getDocumentPaths: blockTable.getDocumentPaths,
    getDocumentBlocksRefs: blockTable.getDocumentBlocksRefs,

    async *getDocumentsBlocks(pathPrefix?: DocumentPath): AsyncGenerator<NgramBlock> {
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
          ...(row.metadata ? { metadata: JSON.parse(row.metadata) as Metadata } : {}),
        };
      }
    },

    async close(): Promise<void> {
      closed = true;
    },

    async flush(): Promise<void> {
      ensureOpen();
    },

    async deleteIndex(): Promise<void> {
      ensureOpen();
      closed = true;
      await db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    },
  };
}
