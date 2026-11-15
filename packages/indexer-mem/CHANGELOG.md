# @statewalker/indexer-mem

## 0.4.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-core crosses a breaking line

### Patch Changes

- Updated dependencies [86fa486]
  - @statewalker/indexer-core@0.3.0

## 0.3.0

### Minor Changes

- d4cd756: One in-memory block store behind the FlexSearch and MiniSearch full-text indexes (#46). `MemBlockStore` owns the blocks keyed by path + blockId, path-prefix selection, enumeration, multi-query score fusion, dirty tracking and the persistence framing; `MemFullTextIndex` is the `FullTextIndex` over it, and each engine is an adapter that supplies only add, remove and search (`MemBlockEngine`). `FlexSearchFullTextIndex` and `MiniSearchFullTextIndex` keep their constructors, every method and its signature, and their serialised format (version 3); their `FullTextIndex` methods are now inherited from `MemFullTextIndex`, which the API diff reads as removed members, hence a minor bump. Callers need no change. The behaviour that had drifted between the two is now the same: `MiniSearchFullTextIndex` gains `isDirty()`, caches its serialised output while unchanged, and stays clean on empty batches and on deletes that remove nothing, as FlexSearch already did. New exports from `@statewalker/indexer-mem`: `MemBlockStore`, `MemBlockEngine`, `MemBlockHit`, `MemBlockStoreOptions`, `RankedKey`, `MEM_BLOCK_STORE_VERSION`, `MemFullTextIndex`, `MemFullTextEngine`; it now depends on `@statewalker/indexer-fulltext`.

## 0.2.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-core crosses a breaking line

### Patch Changes

- Updated dependencies
- Updated dependencies [6ec4ca7]
- Updated dependencies [a39847c]
- Updated dependencies [b0922d4]
- Updated dependencies [5bcbe42]
- Updated dependencies [b70f114]
  - @statewalker/indexer-api@0.1.5
  - @statewalker/indexer-core@0.2.0

## 0.1.5

### Patch Changes

- caf0c2f: Vector writes validate every block's dimensionality before writing anything (SQL retriever, `MemVectorIndex`). The composite's `close()` and `deleteIndex()` run every sub-index's step even when one fails, then rethrow (an `AggregateError` for several). DuckDB drops the `fts_main_<table>` schema with a full-text table, through a new optional `SqlFtsDialect.drop` hook.
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
  - @statewalker/indexer-vector@0.1.5

## 0.1.4

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-api ^0.1.2 -> ^0.1.3
  - @statewalker/indexer-vector ^0.1.2 -> ^0.1.3
- Updated dependencies
- Updated dependencies
  - @statewalker/indexer-core@0.1.3
  - @statewalker/indexer-vector@0.1.4

## 0.1.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/indexer-api@0.1.2
  - @statewalker/indexer-core@0.1.2
  - @statewalker/indexer-vector@0.1.2
