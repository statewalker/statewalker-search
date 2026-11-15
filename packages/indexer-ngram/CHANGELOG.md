# @statewalker/indexer-ngram

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
