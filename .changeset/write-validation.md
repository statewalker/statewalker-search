---
"@statewalker/indexer-core": patch
"@statewalker/indexer-mem": patch
"@statewalker/indexer-duckdb": patch
---

Vector writes validate every block's dimensionality before writing anything (SQL retriever, `MemVectorIndex`). The composite's `close()` and `deleteIndex()` run every sub-index's step even when one fails, then rethrow (an `AggregateError` for several). DuckDB drops the `fts_main_<table>` schema with a full-text table, through a new optional `SqlFtsDialect.drop` hook.
