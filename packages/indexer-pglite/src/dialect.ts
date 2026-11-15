import type { SqlBackedDialect, SqlFtsDialect, SqlVectorDialect } from "@statewalker/indexer-core";
import {
  buildSearchFilterSql,
  embeddingToLiteral,
  ISO_639_1_LANGUAGE_NAMES,
  sqlDocsTableName,
} from "@statewalker/indexer-core";

// ISO-639-1 codes map to the Postgres text-search configuration of the same language name.
const LANGUAGE_MAP: Record<string, string> = {
  ...ISO_639_1_LANGUAGE_NAMES,
  simple: "simple",
};

// Postgres text-search configuration names that have always-on availability;
// any value outside this set is interpolated into DDL/queries and must be a
// whitelisted identifier — never user-controlled free-form text.
const KNOWN_PG_CONFIGS: ReadonlySet<string> = new Set(Object.values(LANGUAGE_MAP));

function resolvePgLanguage(lang: string): string {
  const mapped = LANGUAGE_MAP[lang];
  if (mapped) return mapped;
  if (KNOWN_PG_CONFIGS.has(lang)) return lang;
  throw new Error(
    `pglite FTS: unsupported language "${lang}" (must be an ISO-639-1 code or a Postgres text-search config name)`,
  );
}

/**
 * PGlite FTS dialect — uses native PostgreSQL TSVECTOR with a GIN index, `ts_rank_cd` scoring,
 * and `to_tsquery` with a language-specific stemmer.
 */
export const pgliteFtsDialect: SqlFtsDialect = {
  createTableDdl({ tableName, info }) {
    const pgLang = resolvePgLanguage(info.language);
    return [
      `CREATE TABLE IF NOT EXISTS ${tableName} (doc_id INTEGER NOT NULL, block_id TEXT NOT NULL, content TEXT NOT NULL, content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('${pgLang}', content)) STORED, metadata TEXT, PRIMARY KEY (doc_id, block_id))`,
      `CREATE INDEX IF NOT EXISTS ${tableName}_tsv_idx ON ${tableName} USING GIN (content_tsv)`,
    ];
  },

  async search({ db, tableName, docsTable, info, query, paths, topK }) {
    const pgLang = resolvePgLanguage(info.language);
    // Keep only words: split on everything that is not a Unicode letter, combining mark, digit
    // or `_`, so no tsquery operator (`& | ! ( ) : < > <-> <N>`, quotes, backslash) reaches
    // `to_tsquery`, and non-ASCII words (Russian, Hindi, decomposed accents, …) stay whole.
    const validWords = query
      .toLowerCase()
      .split(/[^\p{L}\p{M}\p{N}_]+/u)
      .filter((w) => w.length > 0);
    if (validWords.length === 0) return [];

    const orTerms = validWords.join(" | ");

    const {
      pathCondition,
      topKParam,
      params: allParams,
    } = buildSearchFilterSql("d.path", paths, topK, [orTerms]);
    const pathClause = pathCondition ? ` AND ${pathCondition}` : "";

    const sql = `SELECT d.path, b.block_id, b.content, ts_rank_cd(b.content_tsv, to_tsquery('${pgLang}', $1)) AS score FROM ${tableName} b JOIN ${docsTable} d ON d.doc_id = b.doc_id WHERE b.content_tsv @@ to_tsquery('${pgLang}', $1)${pathClause} ORDER BY score DESC LIMIT ${topKParam}`;

    const rows = await db.query<{
      path: string;
      block_id: string;
      content: string;
      score: number;
    }>(sql, allParams);

    return rows.map((row) => ({
      path: row.path as import("@statewalker/indexer-api").DocumentPath,
      blockId: row.block_id,
      content: row.content,
      score: row.score,
    }));
  },
};

/**
 * PGlite vector dialect — uses pgvector's HNSW index with the `<=>` cosine-distance operator.
 * Embeddings are bound as stringified array literals.
 */
export const pgliteVectorDialect: SqlVectorDialect = {
  createTableDdl({ tableName, indexName, info }) {
    const dim = info.dimensionality;
    return [
      `CREATE TABLE IF NOT EXISTS ${tableName} (doc_id INTEGER NOT NULL, block_id TEXT NOT NULL, embedding vector(${dim}) NOT NULL, PRIMARY KEY (doc_id, block_id))`,
      `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} USING hnsw (embedding vector_cosine_ops)`,
    ];
  },

  // pgvector's `vector(dim)` column accepts either a JSON-array text literal (`"[1,2,3]"`) cast with
  // `::vector(dim)`, or a JS array bound by the driver. The text-literal path is used because it
  // works uniformly across the pglite vector extension versions available in the catalog; swapping
  // to native array binding is a follow-up when driver support is confirmed.
  bindEmbedding: embeddingToLiteral,
  embeddingCastSuffix: (dim) => `::vector(${dim})`,

  async search({
    db,
    tableName,
    docsTable,
    queryEmbedding,
    paths,
    topK,
    info,
    bindEmbedding,
    embeddingCastSuffix,
  }) {
    const vecLiteral = bindEmbedding(queryEmbedding);
    const dim = info.dimensionality;

    const {
      pathCondition,
      topKParam,
      params: allParams,
    } = buildSearchFilterSql("d.path", paths, topK, [vecLiteral]);
    const pathClause = pathCondition ? `WHERE ${pathCondition} ` : "";

    const rows = await db.query<{ path: string; block_id: string; dist: number }>(
      `SELECT d.path, b.block_id, (b.embedding <=> $1${embeddingCastSuffix(dim)}) AS dist FROM ${tableName} b JOIN ${docsTable} d ON d.doc_id = b.doc_id ${pathClause}ORDER BY dist ASC LIMIT ${topKParam}`,
      allParams,
    );

    return rows.map((row) => ({
      path: row.path as import("@statewalker/indexer-api").DocumentPath,
      blockId: row.block_id,
      score: 1 - row.dist,
    }));
  },

  decodeEmbedding(raw) {
    // PGlite returns vector as a string "[1,2,3]".
    return new Float32Array(JSON.parse(raw as string) as number[]);
  },
};

/** Aggregate PGlite dialect for `createSqlBackedIndexer`. */
export const pgliteDialect: SqlBackedDialect = {
  extensionInit: ["CREATE EXTENSION IF NOT EXISTS vector"],
  docsTableDdl(prefix) {
    return [
      `CREATE TABLE IF NOT EXISTS ${sqlDocsTableName(prefix)} (doc_id SERIAL PRIMARY KEY, path TEXT NOT NULL UNIQUE)`,
    ];
  },
  unionAliasSuffix: " AS combined",
  supportsDDLInTransaction: true,
  fts: pgliteFtsDialect,
  vec: pgliteVectorDialect,
};
