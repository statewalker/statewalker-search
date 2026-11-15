# @statewalker/indexer-mem

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
