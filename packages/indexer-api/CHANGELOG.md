# @statewalker/indexer-api

## 0.1.4

### Patch Changes

- 1fc38ec: Internal refactor, no behaviour change: the SQL full-text and vector retrievers share one block-table module; the `idx_*` table names (unchanged) come from one set of helpers; the DuckDB and PGlite dialects share the embedding literal, the ISO-639-1 language map and the path-filter/`topK` SQL assembly; the full-text, vector and n-gram access handles are thin wrappers over one generic factory. New additive exports: `newSubIndexAccess`, `SubIndexAccess`, `SubIndexAccessOptions` (`@statewalker/indexer-api`); `sqlDocsTableName`, `sqlFtsTableName`, `sqlVectorTableName`, `sqlVectorIndexName`, `sqlSubIndexPrefix`, `buildSearchFilterSql`, `SearchFilterSql`, `embeddingToLiteral`, `ISO_639_1_LANGUAGE_NAMES` (`@statewalker/indexer-core`).
- 32b213c: The composite index copies top-level `SearchRequest.paths` into each sub-query that sets no `paths` of its own, as the API docs describe; a sub-query's own `paths` still wins. Before, top-level `paths` was ignored and searches covered the whole index.

## 0.1.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md

## 0.1.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
