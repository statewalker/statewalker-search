# @statewalker/indexer-chunker

## What it is

Splits Markdown text into chunks of about a target size before indexing. Cuts prefer structural boundaries (headings, code fences, horizontal rules, blank lines) near the target size, and never fall inside a fenced code block. Each chunk carries its start and end offsets in the original text.

## Why it exists

Embedding models and full-text snippets work best on pieces of a few hundred to a few thousand characters. Cutting at a fixed size splits headings from their text and code blocks in half; cutting only at headings gives chunks of any size. This package balances the two: it looks for the best boundary in a window before the target size.

## How to use

```sh
pnpm add @statewalker/indexer-chunker
```

One entry point, `@statewalker/indexer-chunker`. No dependencies; runs anywhere.

`chunkMarkdown(text, options): Chunk[]` with `ChunkOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `targetChars` | required | Target chunk size in characters. |
| `overlap` | `0` | Characters repeated at the start of the next chunk. |
| `windowFraction` | `0.5` | Search window before the target, as a fraction of `targetChars`. |
| `decayFactor` | `0.5` | How strongly distance from the target lowers a break point's score. |

`Chunk` is `{ index, content, startPos, endPos }` (`endPos` exclusive).

## Examples

Chunk a document and index each chunk as a block:

```ts
import { chunkMarkdown } from "@statewalker/indexer-chunker";

const chunks = chunkMarkdown(markdown, { targetChars: 2000, overlap: 200 });
await fts.get(index).addDocument(
  chunks.map((c) => ({ path: "/docs/guide", blockId: String(c.index), content: c.content })),
);
```

Use the building blocks for your own strategy:

```ts
import {
  findBestCutoff,
  findCodeFences,
  isInsideCodeFence,
  scanBreakPoints,
} from "@statewalker/indexer-chunker";

const breakPoints = scanBreakPoints(text); // [{ position, score }]
const fences = findCodeFences(text); // [{ start, end }]
const cut = findBestCutoff(breakPoints, fences, 2000, 1000); // position or -1
const inCode = isInsideCodeFence(fences, cut);
```

## Internals

### How a cut is chosen

```
break point scores:  # 100   ## 90   ### 80   #### 70   ##### 60   ###### 50
                     ``` fence 80    --- / *** / ___ 60   blank line 20
                     list item 5     other newline 1

window = [target - targetChars * windowFraction, target]
final  = score * (1 - (distance / window)^2 * decayFactor)
```

The break point with the highest `final` inside the window wins; break points inside a code fence are skipped. If the cut would land inside or on a fence, it moves to after the closing fence line. The next chunk starts at `cut - overlap`.

Scoring and windowing are adapted from [QMD](https://github.com/tobi/qmd) by Tobi Lutke (MIT).

### Edge cases

- If no break point lies in the window, the cut falls exactly at `targetChars` and can split a word.
- A code block longer than `targetChars` stays in one chunk, so that chunk can be much larger than the target.
- An unclosed fence runs to the end of the text.
- With `overlap`, a chunk can start inside the previous chunk's code block (the overlap is copied as-is).
- Offsets count UTF-16 code units (JavaScript string indexes).

### Dependencies

None.

## License

MIT
