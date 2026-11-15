---
"@statewalker/indexer-core": minor
"@statewalker/indexer-duckdb": patch
"@statewalker/indexer-pglite": patch
---

SQL indexer (DuckDB, PGlite) table names no longer collide (#22, #23). `sanitizePrefix` escapes upper-case letters, so index or sub-index names that differ only in case get their own tables, and prefixes too long for Postgres's 63-byte identifiers are cut and given a hash of the full names (`sqlTableNaming`). Lower-case names short enough keep their table names. Tables created by earlier versions under the old names (`legacySqlTableNaming`) are still found on open and on delete, with no data moved; `createIndex` refuses a name whose tables an earlier version's index already uses. Breaking for direct users of the helpers: `sqlSubIndexPrefix(indexPrefix, subName)` is replaced by `sqlTableNaming.subIndexPrefix(indexName, subName)`, and `sanitizePrefix` escapes upper case (`legacySanitizePrefix` keeps the old behaviour).
