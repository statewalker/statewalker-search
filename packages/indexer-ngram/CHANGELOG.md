# @statewalker/indexer-ngram

## 0.2.0

### Minor Changes

- 86fa486: N-gram (grep) sub-indexes on DuckDB and PGlite (#83). `createDuckDbIndexer` and `createPGLiteIndexer` accept `{ type: "ngram" }` sub-indexes with no extra setup and pass the n-gram conformance suite. Both use one SQL retriever in `indexer-core` (`createSqlNgramRetriever`, registered through the new optional `ngram` part of `SqlBackedDialect`): it plans a pattern with the SQLite backend's planner (`planQuery` from `@statewalker/db-sqlite-index/ngram`), asks the database for candidates, and verifies them in JavaScript, so the matches, offsets, case folding, 10,000-candidate budget and `topK` rules are the SQLite backend's. Only the candidate store differs: PGlite keeps each block's case-folded trigrams in a `text[]` column under a GIN index (store `gin`); DuckDB scans a case-folded copy of the content with `contains` (store `scan`). New tables only (`idx_<subPrefix>_ng`): existing databases are unchanged, and an earlier version treats an n-gram sub-index as an unknown modality. `NgramIndexInfo.store` and `NgramConfig.store` widen to `"fts5" | "postings" | "gin" | "scan"` (`NgramStoreKind`); every backend, SQLite included, refuses a store it does not have. New exports from `@statewalker/indexer-core`: `createSqlNgramRetriever`, `SqlNgramDialect`, `SqlNgramRetrieverOptions`, `SQL_NGRAM_CANDIDATE_BUDGET`, `sqlNgramTableName`, `foldNgramText`, `ngramTrigrams`; it now depends on `@statewalker/indexer-ngram` and `@statewalker/db-sqlite-index`.

## 0.1.2

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-api ^0.1.4 -> ^0.1.5

## 0.1.1

### Patch Changes

- 1fc38ec: Internal refactor, no behaviour change: the SQL full-text and vector retrievers share one block-table module; the `idx_*` table names (unchanged) come from one set of helpers; the DuckDB and PGlite dialects share the embedding literal, the ISO-639-1 language map and the path-filter/`topK` SQL assembly; the full-text, vector and n-gram access handles are thin wrappers over one generic factory. New additive exports: `newSubIndexAccess`, `SubIndexAccess`, `SubIndexAccessOptions` (`@statewalker/indexer-api`); `sqlDocsTableName`, `sqlFtsTableName`, `sqlVectorTableName`, `sqlVectorIndexName`, `sqlSubIndexPrefix`, `buildSearchFilterSql`, `SearchFilterSql`, `embeddingToLiteral`, `ISO_639_1_LANGUAGE_NAMES` (`@statewalker/indexer-core`).
- 665c112: RRF no longer gives the top-rank bonus to items of zero- or negative-weight lists, and returns nothing for a negative `topK`. SQLite sub-indexes throw after `close()` on every read and report a wrong-size query embedding with the shared `Expected dimensionality` error. The modality access handles' `get` throws (and `tryGet` returns `undefined`) when the named binding is of another type, as documented.
- Updated dependencies [1fc38ec]
- Updated dependencies [32b213c]
  - @statewalker/indexer-api@0.1.4

## 0.1.0

### Minor Changes

- d850f85: New n-gram / regex modality contract: `NGRAM_TYPE`, block/query/result types, `newNgramAccess`, config helpers and `grep(index, name, pattern, opts)`.

### Patch Changes

- Updated dependencies
  - @statewalker/indexer-api@0.1.3
