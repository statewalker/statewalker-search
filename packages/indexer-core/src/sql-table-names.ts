import { legacySanitizePrefix, sanitizePrefix } from "./sanitize-prefix.js";

// The table-naming scheme of the SQL indexer (`createSqlIndexer`) and its retrievers. These names
// are a storage format: databases written by earlier versions are opened by them, so every
// rebuild of a name goes through these helpers.
//
//   idx_<indexPrefix>_docs                    per-Index docs table (path -> doc_id)
//   idx_<subPrefix>_fts                       full-text sub-index table
//   idx_<subPrefix>_vec                       vector sub-index table
//   idx_<subPrefix>_vec_hnsw                  vector sub-index HNSW index
//
// Dialects derive a few more names from these (`<docs>_seq`, `<fts>_tsv_idx`). Postgres cuts
// identifiers to 63 bytes, so the prefixes are bounded to leave room for the longest suffix:
// `idx_` + subPrefix + `_fts_tsv_idx` and `idx_` + indexPrefix + `_docs_seq` fit 63 bytes.
//
// Earlier versions kept upper-case letters (which Postgres and DuckDB fold, so `Notes` and
// `notes` shared tables) and had no length bound (so Postgres cut long names into collisions).
// For lower-case names short enough, both schemes give the same strings. `createSqlIndexer` opens
// an Index's tables under the earlier scheme when only those exist.

/** The longest index prefix: `idx_` + 50 + `_docs_seq` = 63. */
export const SQL_MAX_INDEX_PREFIX = 50;
/** The longest sub-index prefix: `idx_` + 47 + `_fts_tsv_idx` = 63. */
export const SQL_MAX_SUB_INDEX_PREFIX = 47;

const HASH_LENGTH = 12;

/** Twelve hex digits of two FNV-1a hashes of the UTF-16 code units of `text`. */
function shortHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${hex(a)}${hex(b)}`.slice(0, HASH_LENGTH);
}

/** `sanitized` itself when it fits `max`, otherwise its start plus `_` and a hash of `key`. */
function bound(sanitized: string, max: number, key: string): string {
  if (sanitized.length <= max) return sanitized;
  return `${sanitized.slice(0, max - HASH_LENGTH - 1)}_${shortHash(key)}`;
}

/** How Index and sub-index names map to the SQL-safe prefixes the table names are built from. */
export interface SqlTableNaming {
  /** The prefix of an Index's own tables (its docs table). */
  indexPrefix(indexName: string): string;
  /** The prefix of one sub-index's tables. */
  subIndexPrefix(indexName: string, subName: string): string;
}

/** The current scheme: upper case escaped, prefixes bounded with a hash of the full names. */
export const sqlTableNaming: SqlTableNaming = {
  indexPrefix(indexName) {
    return bound(sanitizePrefix(indexName), SQL_MAX_INDEX_PREFIX, indexName);
  },
  subIndexPrefix(indexName, subName) {
    return bound(
      `${sanitizePrefix(indexName)}_${sanitizePrefix(subName)}`,
      SQL_MAX_SUB_INDEX_PREFIX,
      `${indexName}\u0000${subName}`,
    );
  },
};

/** The scheme of earlier versions: upper case kept, no length bound. Only for finding their tables. */
export const legacySqlTableNaming: SqlTableNaming = {
  indexPrefix(indexName) {
    return legacySanitizePrefix(indexName);
  },
  subIndexPrefix(indexName, subName) {
    return `${legacySanitizePrefix(indexName)}_${legacySanitizePrefix(subName)}`;
  },
};

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

/** An n-gram sub-index's table: `idx_<subPrefix>_ng`. */
export function sqlNgramTableName(subPrefix: string): string {
  return `idx_${subPrefix}_ng`;
}

/** A vector sub-index's HNSW index: `idx_<subPrefix>_vec_hnsw`. */
export function sqlVectorIndexName(subPrefix: string): string {
  return `idx_${subPrefix}_vec_hnsw`;
}
