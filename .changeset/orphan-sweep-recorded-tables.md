---
"@statewalker/indexer-core": minor
"@statewalker/indexer-duckdb": patch
"@statewalker/indexer-pglite": patch
---

The SQL orphan sweep no longer drops doc rows that a sub-index without a provider still references (statewalker-search#90).

Each Index's manifest entry now records the doc-referencing tables of each sub-index (`docTables`, from the new optional `SqlKernelStorage.docTables`). After a delete, the sweep counts the tables of every sub-index in the manifest, including one kept under `onMissingProvider: "warn"` whose modality has no provider: its recorded tables are passed to `SqlKernelStorage.afterDelete` as a new third argument, `recordedTables`. When such a sub-index has no record (an entry written before this version), the kernel skips the sweep, so it never deletes rows it cannot account for; the orphans it leaves are reclaimed by the next sweep once every provider is back.

Migration: entries gain the record the next time they are written (`createIndex`, a reinit) or opened with `getIndex`. No data is moved.

Rollback: earlier versions ignore the extra field and keep their old sweep, so on those versions the bug can still occur under `onMissingProvider: "warn"`.
