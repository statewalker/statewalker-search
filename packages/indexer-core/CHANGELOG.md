# @statewalker/indexer-core

## 0.3.0

### Minor Changes

- 86fa486: N-gram (grep) sub-indexes on DuckDB and PGlite (#83). `createDuckDbIndexer` and `createPGLiteIndexer` accept `{ type: "ngram" }` sub-indexes with no extra setup and pass the n-gram conformance suite. Both use one SQL retriever in `indexer-core` (`createSqlNgramRetriever`, registered through the new optional `ngram` part of `SqlBackedDialect`): it plans a pattern with the SQLite backend's planner (`planQuery` from `@statewalker/db-sqlite-index/ngram`), asks the database for candidates, and verifies them in JavaScript, so the matches, offsets, case folding, 10,000-candidate budget and `topK` rules are the SQLite backend's. Only the candidate store differs: PGlite keeps each block's case-folded trigrams in a `text[]` column under a GIN index (store `gin`); DuckDB scans a case-folded copy of the content with `contains` (store `scan`). New tables only (`idx_<subPrefix>_ng`): existing databases are unchanged, and an earlier version treats an n-gram sub-index as an unknown modality. `NgramIndexInfo.store` and `NgramConfig.store` widen to `"fts5" | "postings" | "gin" | "scan"` (`NgramStoreKind`); every backend, SQLite included, refuses a store it does not have. New exports from `@statewalker/indexer-core`: `createSqlNgramRetriever`, `SqlNgramDialect`, `SqlNgramRetrieverOptions`, `SQL_NGRAM_CANDIDATE_BUDGET`, `sqlNgramTableName`, `foldNgramText`, `ngramTrigrams`; it now depends on `@statewalker/indexer-ngram` and `@statewalker/db-sqlite-index`.

### Patch Changes

- Updated dependencies [86fa486]
  - @statewalker/indexer-ngram@0.2.0

## 0.2.0

### Minor Changes

- a39847c: One module for the manifest and load-action rules (#47): `planLoad` and `checkCreateSpec` in `indexer-core`, called by `createPersistenceBackedIndexer` and the SQL kernel alike. Divergences settled the same way on every backend: `createIndex` with an empty `subIndexes` creates an empty index (the SQL backends used to throw `Cannot create index without any subIndexes`); `indexer.deleteIndex(name)` on an open index calls that index's own `deleteIndex()` (the in-memory backends used to close it); a missing provider throws `Cannot load index "<name>": sub-index "<sub>" requires modality "<type>" …` (and `Cannot create index "<name>": …` from `createIndex`) on every backend, and the "warn" message names the index. New exports: `planLoad`, `checkCreateSpec`, `missingProviderError`, `LoadPlan`, `SubIndexPlan`.
- b0922d4: One SQL Indexer kernel for DuckDB, PGlite and SQLite (#45). `createSqlKernelIndexer` owns the manifest, the load actions (adopt, skip, reinit, `onMissingProvider`) and the delete and close rules; a `SqlKernelStorage` supplies what differs (the docs table of DuckDB and PGlite, the blocks table of SQLite) and `SqlModalityProvider`s supply the modalities. `createSqlIndexer` and `createSqliteIndexer` keep their signatures and storage formats; `createSqlIndexer` takes optional `providers` to add modalities over the docs table. Behaviour aligned across the three: under `onMissingProvider: "throw"` SQLite now fails before any reinit drops a table, and malformed manifest rows are skipped instead of failing the indexer.
- b70f114: SQL indexer (DuckDB, PGlite) table names no longer collide (#22, #23). `sanitizePrefix` escapes upper-case letters, so index or sub-index names that differ only in case get their own tables, and prefixes too long for Postgres's 63-byte identifiers are cut and given a hash of the full names (`sqlTableNaming`). Lower-case names short enough keep their table names. Tables created by earlier versions under the old names (`legacySqlTableNaming`) are still found on open and on delete, with no data moved; `createIndex` refuses a name whose tables an earlier version's index already uses. Breaking for direct users of the helpers: `sqlSubIndexPrefix(indexPrefix, subName)` is replaced by `sqlTableNaming.subIndexPrefix(indexName, subName)`, and `sanitizePrefix` escapes upper case (`legacySanitizePrefix` keeps the old behaviour).

### Patch Changes

- 6ec4ca7: `createPersistenceBackedIndexer` URI-encodes index and sub-index names in persistence entry names, so a `/` in a name no longer loses that sub-index's data on reload (#20). Names made of `[A-Za-z0-9-_.!~*'()]` keep the same entry names; for other names, loading falls back to the unencoded entry names that earlier versions wrote, and the next save writes the encoded ones.
- 5bcbe42: `createSqlIndexer` (DuckDB, PGlite): deleting documents while a sub-index is skipped no longer removes the docs rows that the skipped sub-index still references (#21). The orphan sweep now checks the tables of every sub-index in the manifest, skipped ones included.
- Updated dependencies
  - @statewalker/indexer-api@0.1.5

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
