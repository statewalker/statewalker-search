---
"@statewalker/indexer-core": patch
"@statewalker/indexer-sqlite": patch
---

Index lifecycle fixes in both indexer builders and the SQLite indexer: `index.close()` evicts the instance so `getIndex` reopens it (with its data, in the provider-based builder); `getIndex`, `deleteIndex`, `flush` and `close` are serialised, so concurrent opens build one instance; `deleteIndex` works after `index.close()` and drops sub-indexes skipped at open; a SQL reinit to an unsupported type no longer drops the old table first. `createCompositeIndex` takes an `onClose` hook.
