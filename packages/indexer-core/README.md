# @statewalker/indexer-core

## What it is

Engine-independent code shared by the `@statewalker/indexer-*` backends: the composite `Index` with RRF fusion, two `Indexer` builders (one provider-based with streaming persistence, one for SQL databases), shared SQL full-text and vector retrievers, and small helpers for path prefixes, persistence bytes and serialised writes. Application code does not need it; it is for people writing a backend.

## Why it exists

Every backend needs the same registry, fusion, manifest and path-prefix logic. Keeping it here means each backend only supplies what differs: a provider per modality (in-memory engines) or a SQL dialect (DuckDB, PGlite). Bugs in fusion or prefix matching are fixed once for all backends.

## How to use

```sh
pnpm add @statewalker/indexer-core
```

One entry point, `@statewalker/indexer-core`. Platform-neutral (no Node or DOM APIs).

| Export | For |
| --- | --- |
| `createPersistenceBackedIndexer({ providers, persistence? })` | An `Indexer` from a list of `ModalityProvider`s, optionally saved through `IndexerPersistence`. |
| `createSqlIndexer({ db, dialect, onClose? })` | An `Indexer` over a SQL database, from a `SqlDb` and a `SqlBackedDialect`. Returns a promise. |
| `createCompositeIndex({ name, metadata?, bindings?, onAfterDelete?, onDeleteIndex? })` | An `Index` over sub-index bindings, used by both builders. |
| `createSqlFtsRetriever(opts)` / `createSqlVectorRetriever(opts)` | SQL-backed `FullTextIndex` / `VectorIndex` from a dialect. |
| `reciprocalRankFusion(lists, topK, k = 60)` | RRF over `RankedList[]`. |
| `matchesPrefix`, `buildPathPrefixSql`, `buildPathPrefixesSql`, `escapeLikePattern` | Path-prefix matching in memory and in SQL. |
| `toBytes`, `singleChunk`, `readEntryBytes` | Build and read `PersistenceEntry` content. |
| `compositeKey`, `sanitizePrefix`, `validateDimensionality`, `toAsyncIterable`, `createSerialiser` | Small helpers. |

Types: `CompositeIndexOptions`, `PersistenceBackedIndexerOptions`, `SqlIndexerOptions`, `SqlBackedDialect`, `SqlFtsDialect`, `SqlFtsRetrieverOptions`, `SqlVectorDialect`, `SqlVectorRetrieverOptions`, `SqlDb`, `RankedList`, `PathPrefixSql`.

## Examples

An in-memory indexer from providers (this is all `@statewalker/indexer-mem-minisearch` does):

```ts
import { createPersistenceBackedIndexer } from "@statewalker/indexer-core";
import { memVectorProvider } from "@statewalker/indexer-mem";
import { miniSearchFullTextProvider } from "@statewalker/indexer-mem-minisearch";

const indexer = createPersistenceBackedIndexer({
  providers: [miniSearchFullTextProvider, memVectorProvider],
  persistence, // optional IndexerPersistence
});
```

A SQL indexer (this is what `@statewalker/indexer-pglite` does):

```ts
import { createSqlIndexer, type SqlDb } from "@statewalker/indexer-core";

const db: SqlDb = { exec: (sql) => ..., query: (sql, params) => ... };
const indexer = await createSqlIndexer({ db, dialect: myDialect, onClose: async () => {} });
```

Fusion:

```ts
import { reciprocalRankFusion } from "@statewalker/indexer-core";

const fused = reciprocalRankFusion(
  [{ results: ftsHits }, { results: vecHits, weight: 0.5 }],
  10,
); // ScoredItem[] sorted by fused score
```

## Internals

### How fusion works

```
score(item) = sum over lists of  weight / (k + rank)      k = 60, rank is 1-based
            + 0.05 if the item's best rank in any list is 1
            + 0.02 if its best rank is 2 or 3
```

The top-rank bonus keeps an item that one sub-index ranks first from being pushed down by items that appear lower in several lists. `createCompositeIndex` keys items by `compositeKey(path, blockId)` (length-prefixed, so no character in a path or block id can collide with the separator), runs only bindings whose name is in `request.subQueries`, and passes each sub-index only its sub-query. Top-level `request.paths` is not forwarded; top-level `topK` only cuts the fused list.

### Persistence-backed indexer: wire format

```
__manifest__                         JSON array of index names
<index>/__manifest__                 JSON { name, subIndexes: { <sub>: { type, ...config } } }
<index>/<sub>/<entry>                each persistable sub-index's serialise() output
```

State is loaded lazily on first use and written on `indexer.flush()` and `indexer.close()`. Nothing is saved before that, so a process that exits without `flush()` or `close()` loses changes. Sub-indexes skipped at load (`{ skip: true }`) keep their saved entries on the next save. Sub-indexes that do not implement `serialise`/`loadFrom` are not saved.

### SQL indexer: tables

```
__indexer_manifest(name, config)            one row per index
idx_<index>_docs(doc_id, path UNIQUE)       shared path -> doc_id map per index
idx_<index>_<sub>_fts                        one table per full-text sub-index
idx_<index>_<sub>_vec                        one table per vector sub-index
```

Names are passed through `sanitizePrefix`, which replaces every character outside `[a-zA-Z0-9]` with `_<charCode>_`, so any index or sub-index name gives a valid SQL identifier. The SQL builder does not use providers: it dispatches each sub-index's `type` to the dialect's `fts` or `vec` part, because the shared docs table does not fit the `ModalityProvider.create(config)` shape. Only `"fulltext"` and `"vector"` types are supported there, and `createIndex` with no sub-indexes throws `Cannot create index without any subIndexes` (the provider-based builder accepts an empty index).

### Writes are serialised

Both builders run mutating calls through `createSerialiser()`: each call waits for the previous one. A failed call does not block the next.

### Dependencies

`@statewalker/indexer-api`, `@statewalker/indexer-fulltext`, `@statewalker/indexer-vector`. No engine dependencies.

## License

MIT
