---
"@statewalker/indexer-core": patch
---

`createSqlIndexer` (DuckDB, PGlite): deleting documents while a sub-index is skipped no longer removes the docs rows that the skipped sub-index still references (#21). The orphan sweep now checks the tables of every sub-index in the manifest, skipped ones included.
