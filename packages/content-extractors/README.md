# @statewalker/content-extractors

## What it is

Turns files into Markdown text for indexing. Each extractor takes the file bytes as an iterable of `Uint8Array` chunks and returns text: PDF (page by page), DOCX (via HTML), XLSX (one Markdown table per sheet), HTML, Markdown and plain text. An `ExtractorRegistry` picks the extractor from the file name, with an optional MIME-type fallback.

## Why it exists

An indexer needs text, while documents arrive as PDF, Office files or HTML. Each format needs a different parser; this package wraps them behind one function type, `ContentExtractor`, so an ingestion pipeline can route any file by name without knowing the parsers. Producing Markdown keeps headings and tables, which `@statewalker/indexer-chunker` then uses as cut points.

## How to use

```sh
pnpm add @statewalker/content-extractors
```

| Import | Gives |
| --- | --- |
| `@statewalker/content-extractors` | Everything below. |
| `@statewalker/content-extractors/extractors` | The extractors and `createDefaultRegistry` only. |
| `@statewalker/content-extractors/types` | `ContentExtractor`, `ContentNormalizer` (types only). |

- `createDefaultRegistry(limits?)` — registry for `*.md`, `*.markdown`, `*.txt`, `*.html`, `*.htm`, `*.pdf`, `*.docx`, `*.docm`, `*.xlsx`; `limits` (`{ maxBytes?, maxUncompressedBytes? }`) applies to every extractor in it.
- `ExtractorRegistry` — `registerByPattern(pattern, extractor)`, `registerByMime(mime, extractor)`, `getByPath(path)`, `getByMime(mime)`, `get(path, mime?)`.
- Extractors with the default limits: `pdfExtractor`, `docxExtractor`, `xlsxExtractor`, `htmlExtractor`, `markdownExtractor`, `textExtractor`.
- Extractor factories with your own limits: `createPdfExtractor({ maxBytes? })`, `createDocxExtractor({ maxBytes?, maxUncompressedBytes? })`, `createXlsxExtractor({ maxBytes?, maxUncompressedBytes? })`, `createHtmlExtractor({ maxBytes? })`, `createMarkdownExtractor({ maxBytes? })`, `createTextExtractor({ maxBytes? })`.
- Limits: `DEFAULT_MAX_BYTES` (100 MiB), `DEFAULT_MAX_UNCOMPRESSED_BYTES` (500 MiB), types `ExtractorLimits`, `ZipExtractorLimits`.
- Helpers: `htmlToMarkdown(html)`, `markdownToHtml(markdown, { html? })`, `getMimeType(path)`, `collectBytes(chunks, { maxBytes? })`, `collectText(chunks, { maxBytes? })`, `zipUncompressedSize(bytes)`, `assertZipUncompressedSize(bytes, maxBytes)`.

## Examples

Extract a file by name:

```ts
import { readFile } from "node:fs/promises";
import { createDefaultRegistry } from "@statewalker/content-extractors";

const registry = createDefaultRegistry();
const extract = registry.get("report.pdf");
if (!extract) throw new Error("unsupported file type");
const markdown = (await extract([await readFile("report.pdf")])) as string;
```

Streamed input works the same way (`AsyncIterable<Uint8Array>`, for example a `fetch` body):

```ts
const response = await fetch(url);
const extract = registry.get(url, response.headers.get("content-type") ?? undefined);
const text = await extract?.(response.body as AsyncIterable<Uint8Array>);
```

Route files without an extension by MIME type:

```ts
import { createDefaultRegistry, htmlExtractor, pdfExtractor } from "@statewalker/content-extractors";

const registry = createDefaultRegistry();
registry.registerByMime("application/pdf", pdfExtractor);
registry.registerByMime("text/html", htmlExtractor);
registry.get("upload-1234", "application/pdf"); // pdfExtractor
```

Change the size limits (see [Input size limits](#input-size-limits)):

```ts
import { createDefaultRegistry, createXlsxExtractor } from "@statewalker/content-extractors";

const registry = createDefaultRegistry({ maxBytes: 20 * 1024 * 1024 }); // 20 MiB per file
registry.registerByPattern("*.xlsx", createXlsxExtractor({ maxUncompressedBytes: 2 * 1024 ** 3 }));
```

Helpers:

```ts
import { getMimeType, htmlToMarkdown, markdownToHtml } from "@statewalker/content-extractors";

getMimeType("a.PDF"); // "application/pdf"
htmlToMarkdown("<h1>T</h1>"); // "# T"
htmlToMarkdown("<p>hi</p><script>alert(1)</script>"); // "hi": script, style, noscript, template are dropped
markdownToHtml("**b**"); // "<p><strong>b</strong></p>\n"
markdownToHtml("<b>x</b>"); // "<p>&lt;b&gt;x&lt;/b&gt;</p>\n": raw HTML is escaped unless { html: true }
```

## Internals

### What each format produces

| Format | Parser | Output |
| --- | --- | --- |
| PDF | `unpdf` | `## Page N` section per non-empty page |
| DOCX, DOCM | `mammoth` to HTML, then `htmlToMarkdown` | Markdown with headings, lists, tables |
| XLSX | `exceljs` | `## <sheet name>` and a Markdown table per sheet; first row is the header; pipes in cells escaped, line breaks as spaces |
| HTML | `turndown` + GFM plugin | ATX headings, fenced code, GFM tables; `<script>`, `<style>`, `<noscript>`, `<template>` dropped |
| Markdown, text | none | UTF-8 decoded text as-is |

### Input size limits

Every built-in extractor reads at most `maxBytes` of input (default `DEFAULT_MAX_BYTES`, 100 MiB) and throws `Input exceeds the limit of N bytes` beyond it; reading stops as soon as the limit is passed, so an endless stream is not buffered. The DOCX, DOCM and XLSX extractors also read the ZIP central directory before handing the archive to mammoth or exceljs, add up the declared uncompressed sizes, and throw `Archive uncompressed size … exceeds the limit …` when the sum is over `maxUncompressedBytes` (default `DEFAULT_MAX_UNCOMPRESSED_BYTES`, 500 MiB). This refuses a small "zip bomb" before it is inflated. Bytes that are not a readable ZIP throw `Invalid ZIP archive: …`.

Pass limits to `createDefaultRegistry(limits)` or to a `create*Extractor(limits)` factory; `Infinity` turns a limit off. `collectBytes` and `collectText` have no limit unless `maxBytes` is given.

The uncompressed check trusts the sizes the archive declares. An archive that lies about them is still caught by JSZip (inside mammoth and exceljs), which compares the inflated size with the declared one, but only after inflating that entry.

### Things that surprise

- **The default registry has no MIME routes.** `createDefaultRegistry().get("upload-1234", "application/pdf")` returns `undefined`; register MIME types yourself as shown above.
- **Path matching is by suffix, longest first.** `*.test.html` beats `*.html`. Matching is case-insensitive on both the file name and the pattern (`*.PDF` matches `report.pdf`), and only the part after the last `/` is used. `getMimeType` also looks only after the last `/`: `notes.md/LICENSE` has no extension.
- **XLSX cells are flattened to one line.** A `|` becomes `\|` and each line break (CR, LF, CRLF) becomes one space, so a cell never adds a column or splits a row.
- **XLSX formula and rich-text cells come out as `[object Object]`**, and dates as `Date.toString()` in the local time zone. Plain numbers and strings are fine.
- **`ContentExtractor` returns `Promise<string | unknown>`.** All built-in extractors return a string; cast or check before use.
- **`markdownToHtml` escapes raw HTML by default.** Extracted files often come from untrusted uploads, so `<script>` or `<img onerror>` in them is shown as text. `{ html: true }` passes raw HTML through; use it only for trusted input, or sanitise the output before rendering it.
- **Everything is read into memory.** PDF, DOCX and XLSX parsers need one contiguous buffer, so `collectBytes` joins the chunks first, up to the `maxBytes` limit.
- `ContentNormalizer` is only an interface: a slot for a post-processing step (for example an LLM clean-up) that this package does not implement.

### Dependencies

`unpdf` (PDF text), `mammoth` (DOCX to HTML), `exceljs` (XLSX), `turndown`, `@joplin/turndown-plugin-gfm` and `@types/turndown` (HTML to Markdown), `markdown-it` (Markdown to HTML).

## License

MIT
