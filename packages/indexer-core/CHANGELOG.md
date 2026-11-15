# @statewalker/indexer-core

## 0.1.4

### Patch Changes

- 1fc38ec: Internal refactor, no behaviour change: the SQL full-text and vector retrievers share one block-table module; the `idx_*` table names (unchanged) come from one set of helpers; the DuckDB and PGlite dialects share the embedding literal, the ISO-639-1 language map and the path-filter/`topK` SQL assembly; the full-text, vector and n-gram access handles are thin wrappers over one generic factory. New additive exports: `newSubIndexAccess`, `SubIndexAccess`, `SubIndexAccessOptions` (`@statewalker/indexer-api`); `sqlDocsTableName`, `sqlFtsTableName`, `sqlVectorTableName`, `sqlVectorIndexName`, `sqlSubIndexPrefix`, `buildSearchFilterSql`, `SearchFilterSql`, `embeddingToLiteral`, `ISO_639_1_LANGUAGE_NAMES` (`@statewalker/indexer-core`).
- 354f404: Index lifecycle fixes in both indexer builders and the SQLite indexer: `index.close()` evicts the instance so `getIndex` reopens it (with its data, in the provider-based builder); `getIndex`, `deleteIndex`, `flush` and `close` are serialised, so concurrent opens build one instance; `deleteIndex` works after `index.close()` and drops sub-indexes skipped at open; a SQL reinit to an unsupported type no longer drops the old table first. `createCompositeIndex` takes an `onClose` hook.
- bfee517: Index-level `metadata` from `createIndex` is saved in the manifest by both indexer builders and by indexer-sqlite, so `getIndex(name).metadata` and `getIndexNames()` return it after a reopen or reload. The indexer-vector README documents that SQL backends do not store per-block `metadata`.
- 4562115: `@types/turndown` is no longer a runtime dependency of content-extractors (no emitted declaration references turndown); indexer-core declares `publishConfig.access: public` like its siblings.
- 665c112: RRF no longer gives the top-rank bonus to items of zero- or negative-weight lists, and returns nothing for a negative `topK`. SQLite sub-indexes throw after `close()` on every read and report a wrong-size query embedding with the shared `Expected dimensionality` error. The modality access handles' `get` throws (and `tryGet` returns `undefined`) when the named binding is of another type, as documented.
- 32b213c: The composite index copies top-level `SearchRequest.paths` into each sub-query that sets no `paths` of its own, as the API docs describe; a sub-query's own `paths` still wins. Before, top-level `paths` was ignored and searches covered the whole index.
- 495876e: PGlite full-text search no longer throws on queries containing `<`, `>`, `<->` or `<N>`, and splits words on `:` instead of joining them. On DuckDB, blocks inserted before a failing block in one `addDocument` call are now searchable.
- caf0c2f: Vector writes validate every block's dimensionality before writing anything (SQL retriever, `MemVectorIndex`). The composite's `close()` and `deleteIndex()` run every sub-index's step even when one fails, then rethrow (an `AggregateError` for several). DuckDB drops the `fts_main_<table>` schema with a full-text table, through a new optional `SqlFtsDialect.drop` hook.
- Updated dependencies [1fc38ec]
- Updated dependencies [bfee517]
- Updated dependencies [665c112]
- Updated dependencies [32b213c]
  - @statewalker/indexer-api@0.1.4
  - @statewalker/indexer-fulltext@0.1.5
  - @statewalker/indexer-vector@0.1.5

## 0.1.3

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-api ^0.1.2 -> ^0.1.3
  - @statewalker/indexer-fulltext ^0.1.2 -> ^0.1.3
  - @statewalker/indexer-vector ^0.1.2 -> ^0.1.3
  - files changed: dist/composite-key.d.ts, dist/composite-key.d.ts.map, dist/composite-key.js, dist/composite-key.js.map, src/composite-key.ts, 1 more
- Updated dependencies
- Updated dependencies
  - @statewalker/indexer-fulltext@0.1.4
  - @statewalker/indexer-vector@0.1.4

## 0.1.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/indexer-api@0.1.2
  - @statewalker/indexer-fulltext@0.1.2
  - @statewalker/indexer-vector@0.1.2
