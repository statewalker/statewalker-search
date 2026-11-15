# @statewalker/indexer-sqlite

## 0.1.2

### Patch Changes

- 354f404: Index lifecycle fixes in both indexer builders and the SQLite indexer: `index.close()` evicts the instance so `getIndex` reopens it (with its data, in the provider-based builder); `getIndex`, `deleteIndex`, `flush` and `close` are serialised, so concurrent opens build one instance; `deleteIndex` works after `index.close()` and drops sub-indexes skipped at open; a SQL reinit to an unsupported type no longer drops the old table first. `createCompositeIndex` takes an `onClose` hook.
- bfee517: Index-level `metadata` from `createIndex` is saved in the manifest by both indexer builders and by indexer-sqlite, so `getIndex(name).metadata` and `getIndexNames()` return it after a reopen or reload. The indexer-vector README documents that SQL backends do not store per-block `metadata`.
- 665c112: RRF no longer gives the top-rank bonus to items of zero- or negative-weight lists, and returns nothing for a negative `topK`. SQLite sub-indexes throw after `close()` on every read and report a wrong-size query embedding with the shared `Expected dimensionality` error. The modality access handles' `get` throws (and `tryGet` returns `undefined`) when the named binding is of another type, as documented.
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
  - @statewalker/indexer-ngram@0.1.1

## 0.1.1

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-core ^0.1.2 -> ^0.1.3
  - @statewalker/indexer-fulltext ^0.1.3 -> ^0.1.4
  - @statewalker/indexer-vector ^0.1.3 -> ^0.1.4

## 0.1.0

### Minor Changes

- 114b13c: New SQLite indexer: FTS5, vector and n-gram/grep sub-indexes in one `@statewalker/db-api` `Db`, on Node, in a browser worker and in Durable Objects.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies [d850f85]
  - @statewalker/indexer-api@0.1.3
  - @statewalker/indexer-fulltext@0.1.3
  - @statewalker/indexer-vector@0.1.3
  - @statewalker/indexer-ngram@0.1.0
