# @statewalker/content-extractors

## 0.3.0

### Minor Changes

- 47027db: `markdownToHtml` escapes raw HTML by default, so rendering output from untrusted Markdown no longer runs embedded scripts; pass `{ html: true }` to keep the old pass-through. `pdfExtractor` accepts a Node `Buffer` and no longer empties the caller's `Uint8Array`.

### Patch Changes

- 6d7bd1b: Harden the extractors against hostile or very large input. `htmlToMarkdown` (and so the HTML and DOCX extractors) drops the content of `<script>`, `<style>`, `<noscript>` and `<template>`. XLSX cells escape `|` and turn line breaks into spaces, so a cell no longer adds a column or splits a row, and sheets with hundreds of thousands of rows no longer overflow the stack. Every extractor now reads at most 100 MiB of input, and DOCX/DOCM/XLSX archives are refused before inflating when their declared uncompressed size is over 500 MiB; both limits are configurable through the new `create*Extractor(limits)` factories and `createDefaultRegistry(limits)`. `collectBytes`/`collectText` take an optional `maxBytes`. New helpers: `zipUncompressedSize`, `assertZipUncompressedSize`. `getMimeType` looks only at the file name (`notes.md/LICENSE` is no longer Markdown), and `registerByPattern` patterns are case-insensitive (`*.PDF` matches `report.pdf`).
- 4562115: `@types/turndown` is no longer a runtime dependency of content-extractors (no emitted declaration references turndown); indexer-core declares `publishConfig.access: public` like its siblings.

## 0.2.3

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
