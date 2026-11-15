---
"@statewalker/indexer-core": patch
"@statewalker/indexer-pglite": patch
---

PGlite full-text search no longer throws on queries containing `<`, `>`, `<->` or `<N>`, and splits words on `:` instead of joining them. On DuckDB, blocks inserted before a failing block in one `addDocument` call are now searchable.
