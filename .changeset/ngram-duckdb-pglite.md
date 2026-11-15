---
"@statewalker/indexer-ngram": minor
"@statewalker/indexer-core": minor
"@statewalker/indexer-duckdb": minor
"@statewalker/indexer-pglite": minor
"@statewalker/indexer-sqlite": patch
---

N-gram (grep) sub-indexes on DuckDB and PGlite (#83). `createDuckDbIndexer` and `createPGLiteIndexer` accept `{ type: "ngram" }` sub-indexes with no extra setup and pass the n-gram conformance suite. Both use one SQL retriever in `indexer-core` (`createSqlNgramRetriever`, registered through the new optional `ngram` part of `SqlBackedDialect`): it plans a pattern with the SQLite backend's planner (`planQuery` from `@statewalker/db-sqlite-index/ngram`), asks the database for candidates, and verifies them in JavaScript, so the matches, offsets, case folding, 10,000-candidate budget and `topK` rules are the SQLite backend's. Only the candidate store differs: PGlite keeps each block's case-folded trigrams in a `text[]` column under a GIN index (store `gin`); DuckDB scans a case-folded copy of the content with `contains` (store `scan`). New tables only (`idx_<subPrefix>_ng`): existing databases are unchanged, and an earlier version treats an n-gram sub-index as an unknown modality. `NgramIndexInfo.store` and `NgramConfig.store` widen to `"fts5" | "postings" | "gin" | "scan"` (`NgramStoreKind`); every backend, SQLite included, refuses a store it does not have. New exports from `@statewalker/indexer-core`: `createSqlNgramRetriever`, `SqlNgramDialect`, `SqlNgramRetrieverOptions`, `SQL_NGRAM_CANDIDATE_BUDGET`, `sqlNgramTableName`, `foldNgramText`, `ngramTrigrams`; it now depends on `@statewalker/indexer-ngram` and `@statewalker/db-sqlite-index`.
