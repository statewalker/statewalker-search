---
"@statewalker/indexer-core": patch
---

`createPersistenceBackedIndexer` URI-encodes index and sub-index names in persistence entry names, so a `/` in a name no longer loses that sub-index's data on reload (#20). Names made of `[A-Za-z0-9-_.!~*'()]` keep the same entry names; for other names, loading falls back to the unencoded entry names that earlier versions wrote, and the next save writes the encoded ones.
