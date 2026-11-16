# @statewalker/indexer-sqlite

## 0.4.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-core crosses a breaking line

### Patch Changes

- Updated dependencies [bdd60b1]
  - @statewalker/indexer-core@0.4.0

## 0.3.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-core crosses a breaking line
  - @statewalker/indexer-ngram crosses a breaking line

### Patch Changes

- 86fa486: N-gram (grep) sub-indexes on DuckDB and PGlite (#83). `createDuckDbIndexer` and `createPGLiteIndexer` accept `{ type: "ngram" }` sub-indexes with no extra setup and pass the n-gram conformance suite. Both use one SQL retriever in `indexer-core` (`createSqlNgramRetriever`, registered through the new optional `ngram` part of `SqlBackedDialect`): it plans a pattern with the SQLite backend's planner (`planQuery` from `@statewalker/db-sqlite-index/ngram`), asks the database for candidates, and verifies them in JavaScript, so the matches, offsets, case folding, 10,000-candidate budget and `topK` rules are the SQLite backend's. Only the candidate store differs: PGlite keeps each block's case-folded trigrams in a `text[]` column under a GIN index (store `gin`); DuckDB scans a case-folded copy of the content with `contains` (store `scan`). New tables only (`idx_<subPrefix>_ng`): existing databases are unchanged, and an earlier version treats an n-gram sub-index as an unknown modality. `NgramIndexInfo.store` and `NgramConfig.store` widen to `"fts5" | "postings" | "gin" | "scan"` (`NgramStoreKind`); every backend, SQLite included, refuses a store it does not have. New exports from `@statewalker/indexer-core`: `createSqlNgramRetriever`, `SqlNgramDialect`, `SqlNgramRetrieverOptions`, `SQL_NGRAM_CANDIDATE_BUDGET`, `sqlNgramTableName`, `foldNgramText`, `ngramTrigrams`; it now depends on `@statewalker/indexer-ngram` and `@statewalker/db-sqlite-index`.
- Updated dependencies [86fa486]
  - @statewalker/indexer-ngram@0.2.0
  - @statewalker/indexer-core@0.3.0

## 0.2.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-core crosses a breaking line

### Patch Changes

- a39847c: One module for the manifest and load-action rules (#47): `planLoad` and `checkCreateSpec` in `indexer-core`, called by `createPersistenceBackedIndexer` and the SQL kernel alike. Divergences settled the same way on every backend: `createIndex` with an empty `subIndexes` creates an empty index (the SQL backends used to throw `Cannot create index without any subIndexes`); `indexer.deleteIndex(name)` on an open index calls that index's own `deleteIndex()` (the in-memory backends used to close it); a missing provider throws `Cannot load index "<name>": sub-index "<sub>" requires modality "<type>" …` (and `Cannot create index "<name>": …` from `createIndex`) on every backend, and the "warn" message names the index. New exports: `planLoad`, `checkCreateSpec`, `missingProviderError`, `LoadPlan`, `SubIndexPlan`.
- b0922d4: One SQL Indexer kernel for DuckDB, PGlite and SQLite (#45). `createSqlKernelIndexer` owns the manifest, the load actions (adopt, skip, reinit, `onMissingProvider`) and the delete and close rules; a `SqlKernelStorage` supplies what differs (the docs table of DuckDB and PGlite, the blocks table of SQLite) and `SqlModalityProvider`s supply the modalities. `createSqlIndexer` and `createSqliteIndexer` keep their signatures and storage formats; `createSqlIndexer` takes optional `providers` to add modalities over the docs table. Behaviour aligned across the three: under `onMissingProvider: "throw"` SQLite now fails before any reinit drops a table, and malformed manifest rows are skipped instead of failing the indexer.
- Updated dependencies
- Updated dependencies [6ec4ca7]
- Updated dependencies [a39847c]
- Updated dependencies [b0922d4]
- Updated dependencies [5bcbe42]
- Updated dependencies [b70f114]
  - @statewalker/indexer-api@0.1.5
  - @statewalker/indexer-core@0.2.0

## 0.1.2

### Patch Changes

- 354f404: Index lifecycle fixes in both indexer builders and the SQLite indexer: `index.close()` evicts the instance so `getIndex` reopens it (with its data, in the provider-based builder); `getIndex`, `deleteIndex`, `flush` and `close` are serialised, so concurrent opens build one instance; `deleteIndex` works after `index.close()` and drops sub-indexes skipped at open; a SQL reinit to an unsupported type no longer drops the old table first. `createCompositeIndex` takes an `onClose` hook.
- bfee517: Index-level `metadata` from `createIndex` is saved in the manifest by both indexer builders and by indexer-sqlite, so `getIndex(name).metadata` and `getIndexNames()` return it after a reopen or reload. The indexer-vector README documents that SQL backends do not store per-block `metadata`.
- 665c112: RRF no longer gives the top-rank bonus to items of zero- or negative-weight lists, and returns nothing for a negative `topK`. SQLite sub-indexes throw after `close()` on every read and report a wrong-size query embedding with the shared `Expected dimensionality` error. The modality access handles' `get` throws (and `tryGet` returns `undefined`) when the named binding is of another type, as documented.
- Updated dependencies [1fc38ec]
- Updated dependencies [354f404]
- Updated dependencies [bfee517]
- Updated dependencies [4562115]
- Updated dependencies [665c112]
- Updated dependencies [32b213c]
- Updated dependencies [495876e]
- Updated dependencies [caf0c2f]
  - @statewalker/indexer-api@0.1.4
  - @statewalker/indexer-core@0.1.4
  - @statewalker/indexer-fulltext@0.1.5
  - @statewalker/indexer-vector@0.1.5
  - @statewalker/indexer-ngram@0.1.1

## 0.1.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-core ^0.1.2 -> ^0.1.3
  - @statewalker/indexer-fulltext ^0.1.3 -> ^0.1.4
  - @statewalker/indexer-vector ^0.1.3 -> ^0.1.4

## 0.1.0

### Minor Changes

- 114b13c: New SQLite indexer: FTS5, vector and n-gram/grep sub-indexes in one `@statewalker/db-api` `Db`, on Node, in a browser worker and in Durable Objects.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies [d850f85]
  - @statewalker/indexer-api@0.1.3
  - @statewalker/indexer-fulltext@0.1.3
  - @statewalker/indexer-vector@0.1.3
  - @statewalker/indexer-ngram@0.1.0
