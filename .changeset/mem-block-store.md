---
"@statewalker/indexer-mem": minor
"@statewalker/indexer-mem-flexsearch": patch
"@statewalker/indexer-mem-minisearch": patch
---

One in-memory block store behind the FlexSearch and MiniSearch full-text indexes (#46). `MemBlockStore` owns the blocks keyed by path + blockId, path-prefix selection, enumeration, multi-query score fusion, dirty tracking and the persistence framing; `MemFullTextIndex` is the `FullTextIndex` over it, and each engine is an adapter that supplies only add, remove and search (`MemBlockEngine`). `FlexSearchFullTextIndex` and `MiniSearchFullTextIndex` keep their constructors, `serialize`/`deserialize` signatures and their serialised format (version 3). The behaviour that had drifted between the two is now the same: `MiniSearchFullTextIndex` gains `isDirty()`, caches its serialised output while unchanged, and stays clean on empty batches and on deletes that remove nothing, as FlexSearch already did. New exports from `@statewalker/indexer-mem`: `MemBlockStore`, `MemBlockEngine`, `MemBlockHit`, `MemBlockStoreOptions`, `RankedKey`, `MEM_BLOCK_STORE_VERSION`, `MemFullTextIndex`, `MemFullTextEngine`; it now depends on `@statewalker/indexer-fulltext`.
