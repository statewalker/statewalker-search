---
"@statewalker/indexer-api": patch
"@statewalker/indexer-core": patch
"@statewalker/indexer-duckdb": patch
"@statewalker/indexer-pglite": patch
"@statewalker/indexer-fulltext": patch
"@statewalker/indexer-vector": patch
"@statewalker/indexer-ngram": patch
---

Internal refactor, no behaviour change: the SQL full-text and vector retrievers share one block-table module; the `idx_*` table names (unchanged) come from one set of helpers; the DuckDB and PGlite dialects share the embedding literal, the ISO-639-1 language map and the path-filter/`topK` SQL assembly; the full-text, vector and n-gram access handles are thin wrappers over one generic factory. New additive exports: `newSubIndexAccess`, `SubIndexAccess`, `SubIndexAccessOptions` (`@statewalker/indexer-api`); `sqlDocsTableName`, `sqlFtsTableName`, `sqlVectorTableName`, `sqlVectorIndexName`, `sqlSubIndexPrefix`, `buildSearchFilterSql`, `SearchFilterSql`, `embeddingToLiteral`, `ISO_639_1_LANGUAGE_NAMES` (`@statewalker/indexer-core`).
