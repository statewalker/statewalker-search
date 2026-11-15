---
"@statewalker/content-extractors": patch
"@statewalker/indexer-core": patch
---

`@types/turndown` is no longer a runtime dependency of content-extractors (no emitted declaration references turndown); indexer-core declares `publishConfig.access: public` like its siblings.
