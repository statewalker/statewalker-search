---
"@statewalker/content-extractors": minor
---

`markdownToHtml` escapes raw HTML by default, so rendering output from untrusted Markdown no longer runs embedded scripts; pass `{ html: true }` to keep the old pass-through. `pdfExtractor` accepts a Node `Buffer` and no longer empties the caller's `Uint8Array`.
