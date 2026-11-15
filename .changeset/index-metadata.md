---
"@statewalker/indexer-core": patch
"@statewalker/indexer-sqlite": patch
"@statewalker/indexer-vector": patch
---

Index-level `metadata` from `createIndex` is saved in the manifest by both indexer builders and by indexer-sqlite, so `getIndex(name).metadata` and `getIndexNames()` return it after a reopen or reload. The indexer-vector README documents that SQL backends do not store per-block `metadata`.
