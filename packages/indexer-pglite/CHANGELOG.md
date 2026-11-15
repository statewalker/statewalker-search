# @statewalker/indexer-pglite

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
