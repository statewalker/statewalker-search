# @statewalker/indexer-mem-flexsearch

## 0.2.0

### Minor Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-core crosses a breaking line
  - @statewalker/indexer-mem crosses a breaking line

### Patch Changes

- a39847c: One module for the manifest and load-action rules (#47): `planLoad` and `checkCreateSpec` in `indexer-core`, called by `createPersistenceBackedIndexer` and the SQL kernel alike. Divergences settled the same way on every backend: `createIndex` with an empty `subIndexes` creates an empty index (the SQL backends used to throw `Cannot create index without any subIndexes`); `indexer.deleteIndex(name)` on an open index calls that index's own `deleteIndex()` (the in-memory backends used to close it); a missing provider throws `Cannot load index "<name>": sub-index "<sub>" requires modality "<type>" …` (and `Cannot create index "<name>": …` from `createIndex`) on every backend, and the "warn" message names the index. New exports: `planLoad`, `checkCreateSpec`, `missingProviderError`, `LoadPlan`, `SubIndexPlan`.
- Updated dependencies
- Updated dependencies
- Updated dependencies [6ec4ca7]
- Updated dependencies [a39847c]
- Updated dependencies [b0922d4]
- Updated dependencies [5bcbe42]
- Updated dependencies [b70f114]
  - @statewalker/indexer-api@0.1.5
  - @statewalker/indexer-mem@0.2.0
  - @statewalker/indexer-core@0.2.0

## 0.1.5

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-api ^0.1.3 -> ^0.1.4
  - @statewalker/indexer-core ^0.1.3 -> ^0.1.4
  - @statewalker/indexer-fulltext ^0.1.4 -> ^0.1.5
  - @statewalker/indexer-mem ^0.1.4 -> ^0.1.5

## 0.1.4

### Patch Changes

- Release of the changes since the last published version:
  
  - @statewalker/indexer-api ^0.1.2 -> ^0.1.3
  - @statewalker/indexer-fulltext ^0.1.2 -> ^0.1.3
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/indexer-core@0.1.3
  - @statewalker/indexer-fulltext@0.1.4
  - @statewalker/indexer-mem@0.1.4

## 0.1.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/indexer-api@0.1.2
  - @statewalker/indexer-core@0.1.2
  - @statewalker/indexer-fulltext@0.1.2
  - @statewalker/indexer-mem@0.1.3
