---
"@statewalker/indexer-core": minor
"@statewalker/indexer-sqlite": patch
"@statewalker/indexer-duckdb": patch
"@statewalker/indexer-pglite": patch
"@statewalker/indexer-mem-flexsearch": patch
"@statewalker/indexer-mem-minisearch": patch
---

One module for the manifest and load-action rules (#47): `planLoad` and `checkCreateSpec` in `indexer-core`, called by `createPersistenceBackedIndexer` and the SQL kernel alike. Divergences settled the same way on every backend: `createIndex` with an empty `subIndexes` creates an empty index (the SQL backends used to throw `Cannot create index without any subIndexes`); `indexer.deleteIndex(name)` on an open index calls that index's own `deleteIndex()` (the in-memory backends used to close it); a missing provider throws `Cannot load index "<name>": sub-index "<sub>" requires modality "<type>" …` (and `Cannot create index "<name>": …` from `createIndex`) on every backend, and the "warn" message names the index. New exports: `planLoad`, `checkCreateSpec`, `missingProviderError`, `LoadPlan`, `SubIndexPlan`.
