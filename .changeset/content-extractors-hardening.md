---
"@statewalker/content-extractors": patch
---

Harden the extractors against hostile or very large input. `htmlToMarkdown` (and so the HTML and DOCX extractors) drops the content of `<script>`, `<style>`, `<noscript>` and `<template>`. XLSX cells escape `|` and turn line breaks into spaces, so a cell no longer adds a column or splits a row, and sheets with hundreds of thousands of rows no longer overflow the stack. Every extractor now reads at most 100 MiB of input, and DOCX/DOCM/XLSX archives are refused before inflating when their declared uncompressed size is over 500 MiB; both limits are configurable through the new `create*Extractor(limits)` factories and `createDefaultRegistry(limits)`. `collectBytes`/`collectText` take an optional `maxBytes`. New helpers: `zipUncompressedSize`, `assertZipUncompressedSize`. `getMimeType` looks only at the file name (`notes.md/LICENSE` is no longer Markdown), and `registerByPattern` patterns are case-insensitive (`*.PDF` matches `report.pdf`).
