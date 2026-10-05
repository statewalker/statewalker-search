# @statewalker/indexer-duckdb

## What it is

An `Indexer` stored in a DuckDB database. Full-text sub-indexes use DuckDB's `fts` extension (BM25 scoring, Snowball stemmers); vector sub-indexes use the `vss` extension (HNSW index, cosine distance). You pass in a `Db` from `@statewalker/db-api`, so the same code works with DuckDB in Node (`@statewalker/db-duckdb-node`) and in the browser (`@statewalker/db-duckdb-browser`).

## Why it exists

The in-memory indexers keep everything in RAM and scan vectors one by one. DuckDB keeps data on disk (or OPFS in the browser), uses an approximate nearest-neighbour index for vectors, ranks text with BM25 and stems words per language. Use it when the collection is large or must persist without a separate save step.

## How to use

```sh
pnpm add @statewalker/indexer-duckdb @statewalker/db-duckdb-node
# or, in the browser: @statewalker/db-duckdb-browser
```

One entry point, `@statewalker/indexer-duckdb`:

- `createDuckDbIndexer({ db }): Promise<Indexer>` — `db` is a `Db` from `@statewalker/db-api`.
- `DuckDbIndexerOptions` — the options type.

## Examples

```ts
import { newNodeDuckDb } from "@statewalker/db-duckdb-node";
import { createDuckDbIndexer } from "@statewalker/indexer-duckdb";
import { newFullTextAccess, setFullTextConfig } from "@statewalker/indexer-fulltext";
import { newVectorAccess, setVectorConfig } from "@statewalker/indexer-vector";

const db = await newNodeDuckDb({ path: "./search.duckdb" }); // omit path for in-memory
const indexer = await createDuckDbIndexer({ db });

const params = { name: "docs" };
setFullTextConfig(params, "q", { language: "en" });
setVectorConfig(params, "semantic", { dimensionality: 384, model: "all-MiniLM-L6-v2" });
const index = await indexer.createIndex(params);

const fts = newFullTextAccess("q");
await fts.get(index).addDocument([{ path: "/docs/a", blockId: "1", content: "running dogs" }]);

const request = { topK: 10 };
fts.setQuery(request, { queries: ["run"] }); // stemmed: matches "running"
for await (const r of index.search(request)) {
  console.log(r.path, r.blockId, fts.getResult(r)?.score); // BM25
}

await indexer.close();
await db.close(); // the indexer does not close a db it did not open
```

## Internals

### Extensions are downloaded at startup

`createDuckDbIndexer` runs `INSTALL fts; LOAD fts;`, `INSTALL vss; LOAD vss;` and `SET hnsw_enable_experimental_persistence = true;`. `INSTALL` fetches the extensions from the DuckDB extension repository the first time. On a host without network access, or where extension downloads are blocked, the call fails with DuckDB's extension download error. The HNSW persistence flag is needed so vector indexes survive closing and reopening a database file; DuckDB marks it experimental.

### The full-text index is rebuilt lazily

The `fts` extension does not update its index on `INSERT` or `DELETE`. The retriever marks the sub-index dirty on every write and runs `PRAGMA create_fts_index(..., overwrite=1)` before the next search (and on `flush()`). The first search after a batch of writes is therefore slower; write in batches, then search.

### Tables

```
__indexer_manifest(name, config)
idx_<index>_docs(doc_id, path UNIQUE)              path -> doc_id
idx_<index>_<sub>_fts(doc_id, block_id, content, metadata, fts_id)
idx_<index>_<sub>_vec(doc_id, block_id, embedding FLOAT[dim])  + HNSW (metric = 'cosine')
```

`fts_id` is a virtual column `doc_id || '_' || block_id`, because `create_fts_index` needs one identifier column. Names are made SQL-safe with `sanitizePrefix`.

### Scores and languages

- Full-text `score` is `match_bm25`. With several `queries` in one sub-query, each block keeps its best score across them (scores are not summed).
- Vector `score` is `1 - array_cosine_distance`.
- `language` takes ISO-639-1 codes: `en`, `fr`, `de`, `es`, `it`, `pt`, `nl`, `ru`, `sv`, `no`, `da`, `fi`, `hu`, `ro`, `tr`. Any other value silently falls back to the `porter` (English) stemmer. Stop words are off.
- Default retrieval depth is `topK = 100` per sub-query.

### Dependencies

`@statewalker/db-api` (the `Db` interface, so the caller chooses Node or browser DuckDB), `@statewalker/indexer-core` (`createSqlIndexer` and the SQL retrievers), `@statewalker/indexer-api`, `@statewalker/indexer-fulltext`, `@statewalker/indexer-vector`.

## License

MIT
