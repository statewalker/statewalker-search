import type { DocumentPath } from "@statewalker/indexer-api";
import type {
  VectorBlock as EmbeddingBlock,
  VectorIndex as EmbeddingIndex,
  VectorIndexInfo as EmbeddingIndexInfo,
  VectorQuery as EmbeddingSearchParams,
  VectorResult as EmbeddingSearchResult,
} from "@statewalker/indexer-vector";
import { compositeKey } from "./composite-key.js";
import type { SqlDb } from "./sql-db.js";
import { createSqlBlockTable } from "./sql-retriever-base.js";
import { sqlVectorIndexName, sqlVectorTableName } from "./sql-table-names.js";
import { validateDimensionality } from "./validate-dimensionality.js";

/**
 * Per-dialect SQL hooks for a vector sub-index.
 *
 * Only the table/HNSW DDL, the search SQL, embedding binding strategy, and the embedding-row decode
 * differ between SQL backends; everything else (CRUD, path filters, doc-id resolution, enumeration)
 * is shared in {@link createSqlVectorRetriever}.
 */
export interface SqlVectorDialect {
  /**
   * DDL statements to create the vector table and its HNSW index. Runs once per sub-index on `init()`.
   */
  createTableDdl(opts: {
    tableName: string;
    indexName: string;
    info: EmbeddingIndexInfo;
  }): string[];

  /** Driver-native binding for an embedding value used in INSERT / SELECT parameter slots. */
  bindEmbedding(embedding: Float32Array): unknown;

  /**
   * The SQL cast suffix for the embedding param; e.g. `::FLOAT[1536]` (DuckDB) or `::vector(1536)` (PGlite).
   * Appended to the embedding parameter placeholder in INSERT and search SQL.
   */
  embeddingCastSuffix(dim: number): string;

  /** Execute a cosine/ANN search for a single query vector. The base iterates embeddings and merges by best score. */
  search(opts: {
    db: SqlDb;
    tableName: string;
    docsTable: string;
    queryEmbedding: Float32Array;
    paths: DocumentPath[] | undefined;
    topK: number;
    info: EmbeddingIndexInfo;
    bindEmbedding(embedding: Float32Array): unknown;
    embeddingCastSuffix(dim: number): string;
  }): Promise<Array<{ path: DocumentPath; blockId: string; score: number }>>;

  /** Driver-specific decode of a raw embedding column value from a SELECT row into a Float32Array. */
  decodeEmbedding(raw: unknown): Float32Array;
}

export interface SqlVectorRetrieverOptions {
  db: SqlDb;
  prefix: string;
  docsTable: string;
  info: EmbeddingIndexInfo;
  dialect: SqlVectorDialect;
}

/**
 * SQL-backed `EmbeddingIndex` implementation shared by every SQL backend. Per-dialect differences are
 * supplied via {@link SqlVectorDialect}. Callers typically expose this as `XxxVectorIndex` in their barrel.
 */
export function createSqlVectorRetriever(opts: SqlVectorRetrieverOptions): EmbeddingIndex & {
  readonly tableName: string;
  init(): Promise<void>;
} {
  const { db, prefix, docsTable, info, dialect } = opts;
  const tableName = sqlVectorTableName(prefix);
  const indexName = sqlVectorIndexName(prefix);
  const dim = info.dimensionality;
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) throw new Error("EmbeddingIndex is closed");
  };

  const blockTable = createSqlBlockTable({ db, tableName, docsTable, ensureOpen });

  return {
    tableName,

    async init(): Promise<void> {
      for (const stmt of dialect.createTableDdl({ tableName, indexName, info })) {
        await db.exec(stmt);
      }
    },

    async getIndexInfo(): Promise<EmbeddingIndexInfo> {
      ensureOpen();
      return { ...info };
    },

    async *search(params: EmbeddingSearchParams): AsyncGenerator<EmbeddingSearchResult> {
      ensureOpen();
      const { embeddings, paths } = params;
      const topK = params.topK ?? 100;
      if (!embeddings || embeddings.length === 0) return;

      const bestScores = new Map<string, EmbeddingSearchResult>();

      for (const queryEmb of embeddings) {
        validateDimensionality(info, queryEmb);
        const rows = await dialect.search({
          db,
          tableName,
          docsTable,
          queryEmbedding: queryEmb,
          paths,
          topK,
          info,
          bindEmbedding: dialect.bindEmbedding,
          embeddingCastSuffix: dialect.embeddingCastSuffix,
        });
        for (const row of rows) {
          const key = compositeKey(row.path, row.blockId);
          const existing = bestScores.get(key);
          if (!existing || row.score > existing.score) {
            bestScores.set(key, {
              path: row.path,
              blockId: row.blockId,
              score: row.score,
            });
          }
        }
      }

      const sorted = [...bestScores.values()].sort((a, b) => b.score - a.score);
      for (const r of sorted.slice(0, topK)) yield r;
    },

    async addDocument(blocks: EmbeddingBlock[]): Promise<void> {
      ensureOpen();
      // Validate the whole batch before writing, so a bad block leaves nothing half-written.
      for (const block of blocks) validateDimensionality(info, block.embedding);
      for (const block of blocks) {
        const docId = await blockTable.resolveDocId(block.path);
        const bound = dialect.bindEmbedding(block.embedding);
        const cast = dialect.embeddingCastSuffix(dim);

        // Single-statement UPSERT: a failed re-ingest can't strand the old row
        // the way a DELETE+INSERT pair would when the INSERT half throws.
        await db.query(
          `INSERT INTO ${tableName} (doc_id, block_id, embedding) VALUES ($1, $2, $3${cast}) ON CONFLICT (doc_id, block_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
          [docId, block.blockId, bound],
        );
      }
    },

    async addDocuments(
      blocks: Iterable<EmbeddingBlock[]> | AsyncIterable<EmbeddingBlock[]>,
    ): Promise<void> {
      ensureOpen();
      for await (const batch of blocks) await this.addDocument(batch);
    },

    deleteDocuments: blockTable.deleteDocuments,
    getSize: blockTable.getSize,
    getDocumentPaths: blockTable.getDocumentPaths,
    getDocumentBlocksRefs: blockTable.getDocumentBlocksRefs,

    async *getDocumentsBlocks(pathPrefix?: DocumentPath): AsyncGenerator<EmbeddingBlock> {
      ensureOpen();
      const rows = await blockTable.selectBlocks<{
        path: string;
        block_id: string;
        embedding: unknown;
      }>("d.path, b.block_id, b.embedding", pathPrefix);
      for (const row of rows) {
        yield {
          path: row.path as DocumentPath,
          blockId: row.block_id,
          embedding: dialect.decodeEmbedding(row.embedding),
        };
      }
    },

    async close(_options?: { force?: boolean }): Promise<void> {
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
