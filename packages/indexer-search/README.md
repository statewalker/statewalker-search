# @statewalker/indexer-search

Private workspace package; not published to npm.

## What it is

Application-side search orchestration over any `Index` from `@statewalker/indexer-api`. `SearchPipeline` runs expand (prompt to typed queries), embed, search, rerank and cite as one call, with each LLM-backed stage supplied as a plain function. It also has `weightedBlend` (re-order fused results by weighted native scores), `blendWithReranker`, mock stage functions for tests, and, under `./utils`, a typed query parser (`lex:` / `vec:` / `hyde:`) and intent-based chunk selection.

## Why it exists

`Index.search` only fuses ranked lists. Query expansion, embedding of query text, reranking and citations depend on models the application chooses, so they live here, above the contract, and not in the backends. The pipeline does not know modality names: the caller's `buildRequest` maps query material onto its own sub-index names.

## How to use

Inside this workspace add `"@statewalker/indexer-search": "workspace:^"`. Its `exports` point at TypeScript sources (`./src/index.ts`, `./src/utils/index.ts`), so consumers need a TypeScript-aware bundler or test runner.

| Import | Gives |
| --- | --- |
| `@statewalker/indexer-search` | `SearchPipeline`, `weightedBlend`, `blendWithReranker`, `DEFAULT_BLEND_TIERS`, `createMockExpander`, `createMockReranker`, `createMockCitationBuilder`, and types (`PipelineConfig`, `PipelineEntry`, `BuildRequestContext`, `QueryExpanderFn`, `RerankerFn`, `CitationBuilderFn`, ...). |
| `@statewalker/indexer-search/utils` | `parseStructuredQuery`, `validateLexQuery`, `validateSemanticQuery`, `extractIntentTerms`, `selectBestChunk`. |

Commands: `pnpm --filter @statewalker/indexer-search test` (Vitest), `typecheck`, `build`.

## Examples

A pipeline over an index with a full-text sub-index `q` and a vector sub-index `semantic`:

```ts
import { newFullTextAccess } from "@statewalker/indexer-fulltext";
import { newVectorAccess } from "@statewalker/indexer-vector";
import { SearchPipeline } from "@statewalker/indexer-search";

const fts = newFullTextAccess("q");
const vec = newVectorAccess("semantic");

const pipeline = new SearchPipeline({
  index,
  embedFn: embed, // (text) => Promise<Float32Array>
  buildRequest: ({ topK, paths, lexQueries, embeddings }) => {
    const request = { topK };
    if (lexQueries.length) fts.setQuery(request, { queries: lexQueries, paths });
    if (embeddings.length) vec.setQuery(request, { embeddings, paths });
    return request;
  },
  getContent: async (blockId, path) => loadBlockText(path, blockId), // for rerank / cite
  expander: async (prompt) => [
    { type: "lex", query: prompt },
    { type: "vec", query: prompt },
  ],
  reranker: async (query, candidates) =>
    candidates.map((c, i) => ({ blockId: c.blockId, score: 1 / (i + 1) })),
  onError: (stage, error) => console.warn(stage, error),
});

const entries = await pipeline
  .setPrompt("distributed consensus")
  .setPaths("/docs/")
  .setTopK(10)
  .setExplain(true)
  .execute(); // PipelineEntry[]: { blockId, path, score, citation?, explain? }
```

Other inputs: `setTextQueries(...)`, `setSemanticQueries(...)`, `setEmbeddings(...)`, `setReranker(fn)`, and `skip("expansion" | "rerank" | "citations")`.

Weighted blending of native scores per sub-index name:

```ts
import { weightedBlend } from "@statewalker/indexer-search";

const results = [];
for await (const r of index.search(request)) results.push(r);
const reordered = weightedBlend(results, { q: 0.7, semantic: 0.3 }, { topK: 10 });
```

Typed query syntax:

```ts
import { parseStructuredQuery } from "@statewalker/indexer-search/utils";

parseStructuredQuery("lex: CAP theorem\nvec: consensus algorithms");
// [{ type: "lex", query: "CAP theorem", line: 1 }, { type: "vec", query: "consensus algorithms", line: 2 }]
parseStructuredQuery("plain question"); // null: no typed lines, use the text as a prompt
```

## Internals

- **Stage failures degrade, they do not throw.** If the expander throws, the prompt is used as a lexical query (and as a semantic one when `embedFn` is set). If the reranker or citation builder throws, retrieval order or entries without citations are returned. `onError(stage, error)` is called first; without it the error is swallowed silently.
- **Errors that do throw:** `No queries, embeddings, or prompt provided to SearchPipeline`, and `Semantic queries provided but no embedFn in pipeline config`.
- **Rerank and cite need `getContent`.** Without it those stages are skipped without notice.
- **Reranker blending is position-aware.** `blendWithReranker` mixes `1 / rank` with the reranker score; the retrieval weight is 0.75 for ranks 1-3, 0.60 for 4-10 and 0.40 below (`DEFAULT_BLEND_TIERS`), so a reranker cannot easily push out the top retrieval hits.
- **Rerank keys entries by `blockId` only.** If two documents use the same block id, their rerank scores and paths can be mixed up. Use block ids that are unique across the index when reranking.
- `weightedBlend` min-max normalises each sub-index's native score over the result set; a name whose scores are all equal falls back to `1 / position`.
- `parseStructuredQuery` throws on an empty typed line (`Empty query after "lex:" prefix on line 2`), on mixing `expand:` with typed lines, and on mixing plain and typed lines.
- Query parser, intent extraction and reranker blending are adapted from [QMD](https://github.com/tobi/qmd) by Tobi Lutke (MIT).
- Dependencies: `@statewalker/indexer-api` only.

## License

MIT
