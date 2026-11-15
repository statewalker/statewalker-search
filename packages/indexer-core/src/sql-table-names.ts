import { sanitizePrefix } from "./sanitize-prefix.js";

// The table-naming scheme of the SQL indexer (`createSqlIndexer`) and its retrievers. These names
// are a storage format: databases written by earlier versions are opened by them, so every
// rebuild of a name goes through these helpers and the strings must never change.
//
//   idx_<indexPrefix>_docs                    per-Index docs table (path -> doc_id)
//   idx_<indexPrefix>_<subName>_fts           full-text sub-index table
//   idx_<indexPrefix>_<subName>_vec           vector sub-index table
//   idx_<indexPrefix>_<subName>_vec_hnsw      vector sub-index HNSW index

/**
 * The SQL-safe prefix of one sub-index: `<indexPrefix>_<sanitized subName>`. `indexPrefix` is the
 * already sanitized Index name (`sanitizePrefix(indexName)`).
 */
export function sqlSubIndexPrefix(indexPrefix: string, subName: string): string {
  return `${indexPrefix}_${sanitizePrefix(subName)}`;
}

/** The per-Index docs table: `idx_<indexPrefix>_docs`. */
export function sqlDocsTableName(indexPrefix: string): string {
  return `idx_${indexPrefix}_docs`;
}

/** A full-text sub-index's table: `idx_<subPrefix>_fts`. */
export function sqlFtsTableName(subPrefix: string): string {
  return `idx_${subPrefix}_fts`;
}

/** A vector sub-index's table: `idx_<subPrefix>_vec`. */
export function sqlVectorTableName(subPrefix: string): string {
  return `idx_${subPrefix}_vec`;
}

/** A vector sub-index's HNSW index: `idx_<subPrefix>_vec_hnsw`. */
export function sqlVectorIndexName(subPrefix: string): string {
  return `idx_${subPrefix}_vec_hnsw`;
}
