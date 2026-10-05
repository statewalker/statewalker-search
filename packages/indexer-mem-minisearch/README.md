# @statewalker/indexer-mem-minisearch

## What it is

An in-memory `Indexer` that uses [MiniSearch](https://github.com/lucaong/minisearch) for full-text sub-indexes and `MemVectorIndex` from `@statewalker/indexer-mem` for vector sub-indexes. State can be saved and restored through an `IndexerPersistence` port you provide (files, IndexedDB, a blob store, ...).

## Why it exists

It needs no database and no native code, so it runs in the browser, in Node and in workers, and starts instantly. Use it for small and medium collections, tests, and offline apps. `@statewalker/indexer-mem-flexsearch` is the same indexer with a different full-text engine; see "How the two in-memory engines differ" below.

## How to use

```sh
pnpm add @statewalker/indexer-mem-minisearch
```

One entry point, `@statewalker/indexer-mem-minisearch`:

- `createMiniSearchIndexer(options?)` returns an `Indexer`. `options.persistence?: IndexerPersistence`.
- `miniSearchFullTextProvider` — the `FullTextProvider`, for building your own indexer with `createPersistenceBackedIndexer`.
- `MiniSearchFullTextIndex` — the full-text sub-index class.
- `MiniSearchIndexerOptions` — the options type.

Add `@statewalker/indexer-fulltext` and `@statewalker/indexer-vector` for the access handles used below.

## Examples

```ts
import { createMiniSearchIndexer } from "@statewalker/indexer-mem-minisearch";
import { newFullTextAccess, setFullTextConfig } from "@statewalker/indexer-fulltext";
import { newVectorAccess, setVectorConfig } from "@statewalker/indexer-vector";

const indexer = createMiniSearchIndexer();

const params = { name: "docs" };
setFullTextConfig(params, "q", { language: "en" });
setVectorConfig(params, "semantic", { dimensionality: 384, model: "all-MiniLM-L6-v2" });
const index = await indexer.createIndex(params);

const fts = newFullTextAccess("q");
await fts.get(index).addDocument([{ path: "/docs/a", blockId: "1", content: "hello world" }]);

const request = { topK: 10 };
fts.setQuery(request, { queries: ["hello"] });
for await (const r of index.search(request)) {
  console.log(r.path, r.blockId, r.score, fts.getResult(r)?.score);
}
```

With persistence:

```ts
import type { IndexerPersistence } from "@statewalker/indexer-api";
import { createMiniSearchIndexer } from "@statewalker/indexer-mem-minisearch";

const persistence: IndexerPersistence = {
  async save(entries) {
    for await (const entry of entries) {
      // write entry.name; read bytes from entry.content (AsyncIterable<Uint8Array>)
    }
  },
  async *load() {
    // yield { name, content } for every saved entry
  },
};

const indexer = createMiniSearchIndexer({ persistence });
// ... createIndex / getIndex, add documents ...
await indexer.flush(); // writes everything; close() also saves
```

## Internals

### When state is saved

Saved state is read on the first indexer call and written on `indexer.flush()` and `indexer.close()`, never in between. A process that exits without one of them loses its changes. `save` receives the whole state each time:

```
__manifest__              JSON array of index names
<index>/__manifest__      JSON { name, subIndexes }
<index>/<sub>/json        full-text sub-index (MiniSearch state, format version 3)
<index>/<sub>/arrow       vector sub-index (Arrow IPC from MemVectorIndex)
```

Loading a saved full-text entry with another format version throws `MiniSearchFullTextIndex: unsupported serialised version <n> (expected 3)`.

### How the two in-memory engines differ

| | FlexSearch | MiniSearch |
| --- | --- | --- |
| Matching | `tokenize: "forward"` (prefix matching), multi-word queries with `suggest: true` so partial matches are returned | `prefix: true`, `fuzzy: 0.2`; if nothing matches, retries without fuzzy, then with `combineWith: "OR"` |
| `score` in `subResults` | rank-based: `1 - rank / hits` per query | MiniSearch relevance score |

In both, a sub-query with several `queries` adds up per-query scores, so blocks matching more queries rank higher. `snippet` is the whole block content. `language` is stored but not used: there is no stemming or stop-word list. Default retrieval depth is `topK = 100` per sub-query.

### Dependencies

`minisearch` (full-text engine), `@statewalker/indexer-mem` (vectors), `@statewalker/indexer-core` (indexer builder), `@statewalker/indexer-api`, `@statewalker/indexer-fulltext`.

## License

MIT
