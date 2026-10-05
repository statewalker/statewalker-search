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

- `createDefaultRegistry()` — registry for `*.md`, `*.markdown`, `*.txt`, `*.html`, `*.htm`, `*.pdf`, `*.docx`, `*.docm`, `*.xlsx`.
- `ExtractorRegistry` — `registerByPattern(pattern, extractor)`, `registerByMime(mime, extractor)`, `getByPath(path)`, `getByMime(mime)`, `get(path, mime?)`.
- Extractors: `pdfExtractor`, `docxExtractor`, `xlsxExtractor`, `htmlExtractor`, `markdownExtractor`, `textExtractor`.
- Helpers: `htmlToMarkdown(html)`, `markdownToHtml(markdown)`, `getMimeType(path)`, `collectBytes(chunks)`, `collectText(chunks)`.

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

Helpers:

```ts
import { getMimeType, htmlToMarkdown, markdownToHtml } from "@statewalker/content-extractors";

getMimeType("a.PDF"); // "application/pdf"
htmlToMarkdown("<h1>T</h1>"); // "# T"
markdownToHtml("**b**"); // "<p><strong>b</strong></p>\n"
```

## Internals

### What each format produces

| Format | Parser | Output |
| --- | --- | --- |
| PDF | `unpdf` | `## Page N` section per non-empty page |
| DOCX, DOCM | `mammoth` to HTML, then `htmlToMarkdown` | Markdown with headings, lists, tables |
| XLSX | `exceljs` | `## <sheet name>` and a Markdown table per sheet; first row is the header |
| HTML | `turndown` + GFM plugin | ATX headings, fenced code, GFM tables |
| Markdown, text | none | UTF-8 decoded text as-is |

### Things that surprise

- **The default registry has no MIME routes.** `createDefaultRegistry().get("upload-1234", "application/pdf")` returns `undefined`; register MIME types yourself as shown above.
- **Path matching is by suffix, longest first.** `*.test.html` beats `*.html`. Matching is case-insensitive on the file name, and only the part after the last `/` is used.
- **XLSX formula and rich-text cells come out as `[object Object]`**, and dates as `Date.toString()` in the local time zone. Plain numbers and strings are fine.
- **`ContentExtractor` returns `Promise<string | unknown>`.** All built-in extractors return a string; cast or check before use.
- **Everything is read into memory.** PDF, DOCX and XLSX parsers need one contiguous buffer, so `collectBytes` joins the chunks first.
- `ContentNormalizer` is only an interface: a slot for a post-processing step (for example an LLM clean-up) that this package does not implement.

### Dependencies

`unpdf` (PDF text), `mammoth` (DOCX to HTML), `exceljs` (XLSX), `turndown`, `@joplin/turndown-plugin-gfm` and `@types/turndown` (HTML to Markdown), `markdown-it` (Markdown to HTML).

## License

MIT
