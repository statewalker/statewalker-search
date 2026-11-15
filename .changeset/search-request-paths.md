---
"@statewalker/indexer-core": patch
"@statewalker/indexer-api": patch
---

The composite index copies top-level `SearchRequest.paths` into each sub-query that sets no `paths` of its own, as the API docs describe; a sub-query's own `paths` still wins. Before, top-level `paths` was ignored and searches covered the whole index.
