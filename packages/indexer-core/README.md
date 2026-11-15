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
| `createCompositeIndex({ name, metadata?, bindings?, onAfterDelete?, onDeleteIndex?, onClose? })` | An `Index` over sub-index bindings, used by both builders. |
| `createSqlFtsRetriever(opts)` / `createSqlVectorRetriever(opts)` | SQL-backed `FullTextIndex` / `VectorIndex` from a dialect. |
| `reciprocalRankFusion(lists, topK, k = 60)` | RRF over `RankedList[]`. |
| `matchesPrefix`, `buildPathPrefixSql`, `buildPathPrefixesSql`, `escapeLikePattern` | Path-prefix matching in memory and in SQL. |
| `toBytes`, `singleChunk`, `readEntryBytes` | Build and read `PersistenceEntry` content. |
| `sqlTableNaming`, `legacySqlTableNaming`, `SqlTableNaming`, `sqlDocsTableName`, `sqlFtsTableName`, `sqlVectorTableName`, `sqlVectorIndexName` | The `idx_*` table names of the SQL indexer (a storage format), and the earlier versions' scheme used to find their tables. |
| `buildSearchFilterSql`, `embeddingToLiteral`, `ISO_639_1_LANGUAGE_NAMES` | Pieces SQL dialects share: path filter plus `topK` bind values, embedding array literal, ISO-639-1 code to language name. |
| `compositeKey`, `sanitizePrefix`, `legacySanitizePrefix`, `validateDimensionality`, `toAsyncIterable`, `createSerialiser` | Small helpers. |

Types: `CompositeIndexOptions`, `PersistenceBackedIndexerOptions`, `SqlIndexerOptions`, `SqlBackedDialect`, `SqlFtsDialect`, `SqlFtsRetrieverOptions`, `SqlVectorDialect`, `SqlVectorRetrieverOptions`, `SqlDb`, `RankedList`, `PathPrefixSql`, `SearchFilterSql`.

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

The top-rank bonus keeps an item that one sub-index ranks first from being pushed down by items that appear lower in several lists. `createCompositeIndex` keys items by `compositeKey(path, blockId)` (length-prefixed, so no character in a path or block id can collide with the separator), runs only bindings whose name is in `request.subQueries`, and passes each sub-index only its sub-query. Top-level `request.paths` is copied into each sub-query object that sets no `paths` of its own; top-level `topK` only cuts the fused list.

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

Names are passed through `sanitizePrefix`, which replaces every character outside `[a-z0-9]` with `_<charCode>_`, so any index or sub-index name gives a valid SQL identifier. Upper-case letters are escaped too, because Postgres and DuckDB fold unquoted identifiers to lower case (`Notes` and `notes` must not share tables). Postgres cuts identifiers to 63 bytes, so an index prefix longer than 50 characters, or a sub-index prefix (`<index>_<sub>`) longer than 47, is cut and given a 12-digit hash of the full names (`sqlTableNaming`); every derived name then fits.

Earlier versions kept upper case and did not bound lengths (`legacySqlTableNaming`). For lower-case names short enough, both schemes give the same names. When an index or sub-index has tables only under the earlier scheme, `getIndex` and `deleteIndex` use those, so databases written by earlier versions keep opening without moving data; new and reinitialised sub-indexes get the current names. `createIndex` refuses a name whose tables an earlier version's index already uses (for example `notes` next to an old `Notes`), instead of sharing them. The SQL builder does not use providers: it dispatches each sub-index's `type` to the dialect's `fts` or `vec` part, because the shared docs table does not fit the `ModalityProvider.create(config)` shape. Only `"fulltext"` and `"vector"` types are supported there, and `createIndex` with no sub-indexes throws `Cannot create index without any subIndexes` (the provider-based builder accepts an empty index).

### Writes are serialised

Both builders run `createIndex`, `getIndex`, `deleteIndex`, `flush` and `close` through `createSerialiser()`: each call waits for the previous one, so concurrent `getIndex` calls for one name open one instance. A failed call does not block the next.

### Index metadata

Both builders store `CreateIndexParams.metadata` in the index's manifest entry (an optional `metadata` field in its JSON), so `getIndex(name).metadata` and `getIndexNames()` return it after a reopen or reload. Manifests written before this have no `metadata` field and load as before; older versions reading a newer manifest ignore the field.

### Closing and deleting an index

`index.close()` removes the instance from its indexer (the composite's `onClose` hook), so a later `getIndex` opens a new one. The provider-based builder first keeps the closed index's manifest and serialised sub-indexes in memory, so the reopened index has its data and the next save still writes it. `indexer.deleteIndex(name)` works on a closed index too, and both it and `index.deleteIndex()` drop every sub-index the manifest names, including those skipped at open. A reinit (`getIndex(name, { subIndexes: { sub: config } })`) checks that the new type is supported before dropping the old sub-index. `close()` and `deleteIndex()` on the composite run every sub-index's step even when one throws, then rethrow (an `AggregateError` when several failed). A SQL full-text dialect may define `drop` to remove auxiliary structures with the table; DuckDB uses it for the `fts_main_<table>` schema.

### Dependencies

`@statewalker/indexer-api`, `@statewalker/indexer-fulltext`, `@statewalker/indexer-vector`. No engine dependencies.

## License

MIT
