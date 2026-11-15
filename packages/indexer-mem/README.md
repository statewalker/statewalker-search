# @statewalker/indexer-mem

## What it is

An in-memory vector sub-index, `MemVectorIndex`, and `memVectorProvider`, the `VectorProvider` that creates it. Search is a brute-force cosine scan over all stored embeddings. The index can save itself as one Apache Arrow IPC stream.

It also holds the in-memory block store behind the full-text indexes. `MemBlockStore` owns the blocks keyed by path + blockId, path-prefix selection, enumeration, multi-query score fusion (scores summed across queries), dirty tracking and the persistence framing (`{ version: 3, ...engineState, blocks }`). `MemFullTextIndex` is the `FullTextIndex` over that store. A full-text engine plugs in as a `MemBlockEngine` adapter that supplies only `add`, `remove`, `search` and `exportState`.

## Why it exists

The in-memory indexers (`@statewalker/indexer-mem-flexsearch`, `@statewalker/indexer-mem-minisearch`) differ only in their full-text engine. Both use this package for the vector side and for the full-text block store, so the vector code, the block and path rules and the file formats exist once, and another engine costs only an adapter.

## How to use

```sh
pnpm add @statewalker/indexer-mem
```

One entry point, `@statewalker/indexer-mem`: `MemVectorIndex`, `memVectorProvider`, `MemBlockStore`, `MemBlockEngine`, `MemFullTextIndex`. Runs anywhere (browser, Node, workers).

Most applications use `createFlexSearchIndexer` or `createMiniSearchIndexer`, which already include `memVectorProvider`. Use this package directly when you build your own indexer from providers.

## Examples

Combine with a full-text provider in a custom indexer:

```ts
import { createPersistenceBackedIndexer } from "@statewalker/indexer-core";
import { memVectorProvider } from "@statewalker/indexer-mem";
import { flexSearchFullTextProvider } from "@statewalker/indexer-mem-flexsearch";

const indexer = createPersistenceBackedIndexer({
  providers: [flexSearchFullTextProvider, memVectorProvider],
});
```

Use a `MemVectorIndex` on its own:

```ts
import { MemVectorIndex } from "@statewalker/indexer-mem";

const vectors = new MemVectorIndex({ dimensionality: 3, model: "test" });
await vectors.addDocument([{ path: "/a", blockId: "1", embedding: new Float32Array([1, 0, 0]) }]);
for await (const hit of vectors.search({ embeddings: [new Float32Array([1, 0, 0])], topK: 5 })) {
  console.log(hit.path, hit.blockId, hit.score); // cosine similarity
}
```

## Internals

- **Brute force, on purpose.** Every search computes cosine similarity against every stored vector. There is no ANN index, so cost grows linearly with the number of blocks. For large collections use `@statewalker/indexer-duckdb` or `@statewalker/indexer-pglite` (HNSW).
- **Persistence.** `serialise()` yields one entry named `arrow`: an Arrow IPC stream with columns `path`, `blockId`, `embedding` (`FixedSizeList<Float32>[dimensionality]`) and `metadata` (JSON text). The bytes are cached until the next change, so repeated `flush()` calls without writes do not re-encode. `loadFrom` ignores entries with other names.
- **Several query embeddings**: each block keeps its best similarity across them.
- **Dimensionality is checked** on `addDocument` and `search`: `Expected dimensionality 384, got 768`.
- Dependencies: `@uwdata/flechette` (Arrow encoding without the full Apache Arrow library), `@statewalker/indexer-api`, `@statewalker/indexer-vector`, `@statewalker/indexer-core`.

## License

MIT
