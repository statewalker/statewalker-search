# @statewalker/indexer-pglite

## 0.5.0

### Minor Changes

- 86fa486: N-gram (grep) sub-indexes on DuckDB and PGlite (#83). `createDuckDbIndexer` and `createPGLiteIndexer` accept `{ type: "ngram" }` sub-indexes with no extra setup and pass the n-gram conformance suite. Both use one SQL retriever in `indexer-core` (`createSqlNgramRetriever`, registered through the new optional `ngram` part of `SqlBackedDialect`): it plans a pattern with the SQLite backend's planner (`planQuery` from `@statewalker/db-sqlite-index/ngram`), asks the database for candidates, and verifies them in JavaScript, so the matches, offsets, case folding, 10,000-candidate budget and `topK` rules are the SQLite backend's. Only the candidate store differs: PGlite keeps each block's case-folded trigrams in a `text[]` column under a GIN index (store `gin`); DuckDB scans a case-folded copy of the content with `contains` (store `scan`). New tables only (`idx_<subPrefix>_ng`): existing databases are unchanged, and an earlier version treats an n-gram sub-index as an unknown modality. `NgramIndexInfo.store` and `NgramConfig.store` widen to `"fts5" | "postings" | "gin" | "scan"` (`NgramStoreKind`); every backend, SQLite included, refuses a store it does not have. New exports from `@statewalker/indexer-core`: `createSqlNgramRetriever`, `SqlNgramDialect`, `SqlNgramRetrieverOptions`, `SQL_NGRAM_CANDIDATE_BUDGET`, `sqlNgramTableName`, `foldNgramText`, `ngramTrigrams`; it now depends on `@statewalker/indexer-ngram` and `@statewalker/db-sqlite-index`.

### Patch Changes

- Updated dependencies [86fa486]
  - @statewalker/indexer-core@0.3.0

## 0.4.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-core crosses a breaking line

### Patch Changes

- a39847c: One module for the manifest and load-action rules (#47): `planLoad` and `checkCreateSpec` in `indexer-core`, called by `createPersistenceBackedIndexer` and the SQL kernel alike. Divergences settled the same way on every backend: `createIndex` with an empty `subIndexes` creates an empty index (the SQL backends used to throw `Cannot create index without any subIndexes`); `indexer.deleteIndex(name)` on an open index calls that index's own `deleteIndex()` (the in-memory backends used to close it); a missing provider throws `Cannot load index "<name>": sub-index "<sub>" requires modality "<type>" …` (and `Cannot create index "<name>": …` from `createIndex`) on every backend, and the "warn" message names the index. New exports: `planLoad`, `checkCreateSpec`, `missingProviderError`, `LoadPlan`, `SubIndexPlan`.
- b0922d4: One SQL Indexer kernel for DuckDB, PGlite and SQLite (#45). `createSqlKernelIndexer` owns the manifest, the load actions (adopt, skip, reinit, `onMissingProvider`) and the delete and close rules; a `SqlKernelStorage` supplies what differs (the docs table of DuckDB and PGlite, the blocks table of SQLite) and `SqlModalityProvider`s supply the modalities. `createSqlIndexer` and `createSqliteIndexer` keep their signatures and storage formats; `createSqlIndexer` takes optional `providers` to add modalities over the docs table. Behaviour aligned across the three: under `onMissingProvider: "throw"` SQLite now fails before any reinit drops a table, and malformed manifest rows are skipped instead of failing the indexer.
- b70f114: SQL indexer (DuckDB, PGlite) table names no longer collide (#22, #23). `sanitizePrefix` escapes upper-case letters, so index or sub-index names that differ only in case get their own tables, and prefixes too long for Postgres's 63-byte identifiers are cut and given a hash of the full names (`sqlTableNaming`). Lower-case names short enough keep their table names. Tables created by earlier versions under the old names (`legacySqlTableNaming`) are still found on open and on delete, with no data moved; `createIndex` refuses a name whose tables an earlier version's index already uses. Breaking for direct users of the helpers: `sqlSubIndexPrefix(indexPrefix, subName)` is replaced by `sqlTableNaming.subIndexPrefix(indexName, subName)`, and `sanitizePrefix` escapes upper case (`legacySanitizePrefix` keeps the old behaviour).
- Updated dependencies
- Updated dependencies [6ec4ca7]
- Updated dependencies [a39847c]
- Updated dependencies [b0922d4]
- Updated dependencies [5bcbe42]
- Updated dependencies [b70f114]
  - @statewalker/indexer-api@0.1.5
  - @statewalker/indexer-core@0.2.0

## 0.3.2

### Patch Changes

- 1fc38ec: Internal refactor, no behaviour change: the SQL full-text and vector retrievers share one block-table module; the `idx_*` table names (unchanged) come from one set of helpers; the DuckDB and PGlite dialects share the embedding literal, the ISO-639-1 language map and the path-filter/`topK` SQL assembly; the full-text, vector and n-gram access handles are thin wrappers over one generic factory. New additive exports: `newSubIndexAccess`, `SubIndexAccess`, `SubIndexAccessOptions` (`@statewalker/indexer-api`); `sqlDocsTableName`, `sqlFtsTableName`, `sqlVectorTableName`, `sqlVectorIndexName`, `sqlSubIndexPrefix`, `buildSearchFilterSql`, `SearchFilterSql`, `embeddingToLiteral`, `ISO_639_1_LANGUAGE_NAMES` (`@statewalker/indexer-core`).
- 495876e: PGlite full-text search no longer throws on queries containing `<`, `>`, `<->` or `<N>`, and splits words on `:` instead of joining them. On DuckDB, blocks inserted before a failing block in one `addDocument` call are now searchable.
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

## 0.3.1

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: dist/dialect.js, dist/dialect.js.map, src/dialect.ts
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/indexer-core@0.1.3
  - @statewalker/indexer-fulltext@0.1.4
  - @statewalker/indexer-vector@0.1.4

## 0.3.0

### Minor Changes

- dedfa8d: `createPGLiteIndexer({ db })` now takes a `@statewalker/db-api` `Db` (from `@statewalker/db-pglite`) instead of a `PGlite`. The caller loads the vector extension and owns the database: the indexer no longer creates or closes it. `@electric-sql/pglite` and `@electric-sql/pglite-pgvector` are no longer dependencies; install `@statewalker/db-pglite` and `@electric-sql/pglite-pgvector` yourself. Breaking.
  
  Migration:
  
  ```ts
  import { vector } from "@electric-sql/pglite-pgvector";
  import { newPgliteDb } from "@statewalker/db-pglite";
  import { createPGLiteIndexer } from "@statewalker/indexer-pglite";
  
  // was: createPGLiteIndexer()  (in-memory; the indexer closed the PGlite)
  const db = await newPgliteDb({ extensions: { vector } });
  
  // was: createPGLiteIndexer({ db: await PGlite.create({ dataDir, extensions: { vector } }) })
  // An existing PGlite instance can no longer be passed; use `path` where you used `dataDir`:
  // const db = await newPgliteDb({ path: dataDir, extensions: { vector } });
  
  const indexer = await createPGLiteIndexer({ db });
  // ...
  await indexer.close();
  await db.close(); // the indexer no longer closes the database
  ```

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/indexer-api@0.1.3
  - @statewalker/indexer-fulltext@0.1.3
  - @statewalker/indexer-vector@0.1.3

## 0.2.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/indexer-api@0.1.2
  - @statewalker/indexer-core@0.1.2
  - @statewalker/indexer-fulltext@0.1.2
  - @statewalker/indexer-vector@0.1.2
