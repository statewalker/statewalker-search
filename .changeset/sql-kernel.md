---
"@statewalker/indexer-core": minor
"@statewalker/indexer-sqlite": patch
"@statewalker/indexer-duckdb": patch
"@statewalker/indexer-pglite": patch
---

One SQL Indexer kernel for DuckDB, PGlite and SQLite (#45). `createSqlKernelIndexer` owns the manifest, the load actions (adopt, skip, reinit, `onMissingProvider`) and the delete and close rules; a `SqlKernelStorage` supplies what differs (the docs table of DuckDB and PGlite, the blocks table of SQLite) and `SqlModalityProvider`s supply the modalities. `createSqlIndexer` and `createSqliteIndexer` keep their signatures and storage formats; `createSqlIndexer` takes optional `providers` to add modalities over the docs table. Behaviour aligned across the three: under `onMissingProvider: "throw"` SQLite now fails before any reinit drops a table, and malformed manifest rows are skipped instead of failing the indexer.
