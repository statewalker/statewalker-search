---
"@statewalker/indexer-core": patch
"@statewalker/indexer-sqlite": patch
"@statewalker/indexer-fulltext": patch
"@statewalker/indexer-vector": patch
"@statewalker/indexer-ngram": patch
---

RRF no longer gives the top-rank bonus to items of zero- or negative-weight lists, and returns nothing for a negative `topK`. SQLite sub-indexes throw after `close()` on every read and report a wrong-size query embedding with the shared `Expected dimensionality` error. The modality access handles' `get` throws (and `tryGet` returns `undefined`) when the named binding is of another type, as documented.
