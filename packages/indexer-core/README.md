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
| `createSqlIndexer({ db, dialect, onClose?, providers?, tableNaming? })` | An `Indexer` over a docs-table SQL database (DuckDB, PGlite), from a `SqlDb` and a `SqlBackedDialect`; `providers` adds modalities over the same docs table. Returns a promise. |
| `createSqlKernelIndexer({ storage, providers })` | The SQL Indexer lifecycle over a `SqlKernelStorage` and `SqlModalityProvider`s; `createSqlIndexer` and indexer-sqlite are built on it. Returns a promise. |
| `createCompositeIndex({ name, metadata?, bindings?, onAfterDelete?, onDeleteIndex?, onClose? })` | An `Index` over sub-index bindings, used by both builders. |
| `createSqlFtsRetriever(opts)` / `createSqlVectorRetriever(opts)` | SQL-backed `FullTextIndex` / `VectorIndex` from a dialect. |
| `reciprocalRankFusion(lists, topK, k = 60)` | RRF over `RankedList[]`. |
| `matchesPrefix`, `buildPathPrefixSql`, `buildPathPrefixesSql`, `escapeLikePattern` | Path-prefix matching in memory and in SQL. |
| `toBytes`, `singleChunk`, `readEntryBytes` | Build and read `PersistenceEntry` content. |
| `sqlTableNaming`, `legacySqlTableNaming`, `SqlTableNaming`, `sqlDocsTableName`, `sqlFtsTableName`, `sqlVectorTableName`, `sqlVectorIndexName` | The `idx_*` table names of the SQL indexer (a storage format), and the earlier versions' scheme used to find their tables. |
| `buildSearchFilterSql`, `embeddingToLiteral`, `ISO_639_1_LANGUAGE_NAMES` | Pieces SQL dialects share: path filter plus `topK` bind values, embedding array literal, ISO-639-1 code to language name. |
| `compositeKey`, `sanitizePrefix`, `legacySanitizePrefix`, `validateDimensionality`, `toAsyncIterable`, `createSerialiser` | Small helpers. |

Types: `CompositeIndexOptions`, `PersistenceBackedIndexerOptions`, `SqlIndexerOptions`, `SqlDocsContext`, `SqlDocsModalityProvider`, `SqlKernelOptions`, `SqlKernelStorage`, `SqlKernelSubIndex`, `SqlModalityProvider`, `SubIndexSpec`, `SqlBackedDialect`, `SqlFtsDialect`, `SqlFtsRetrieverOptions`, `SqlVectorDialect`, `SqlVectorRetrieverOptions`, `SqlDb`, `RankedList`, `PathPrefixSql`, `SearchFilterSql`.

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

Both SQL indexers are the SQL kernel (`createSqlKernelIndexer`) over a storage: the manifest table, the load actions and the delete rules are one module; `createSqlIndexer` supplies the docs table, the orphan sweep after deletes (every sub-index in the manifest counts, skipped ones too) and the full-text and vector providers from the dialect.

Names are passed through `sanitizePrefix`, which replaces every character outside `[a-z0-9]` with `_<charCode>_`, so any index or sub-index name gives a valid SQL identifier. Upper-case letters are escaped too, because Postgres and DuckDB fold unquoted identifiers to lower case (`Notes` and `notes` must not share tables). Postgres cuts identifiers to 63 bytes, so an index prefix longer than 50 characters, or a sub-index prefix (`<index>_<sub>`) longer than 47, is cut and given a 12-digit hash of the full names (`sqlTableNaming`); every derived name then fits.

Earlier versions kept upper case and did not bound lengths (`legacySqlTableNaming`). For lower-case names short enough, both schemes give the same names. An index created by this version is marked in its manifest entry (`"tableNaming": 2`), and its tables are only ever looked up under the current scheme: an earlier name can fold onto another index's table (`idx_Notes_…` is `idx_notes_…`). For an index created by an earlier version, when an index or sub-index has tables only under the earlier scheme, `getIndex` and `deleteIndex` use those, so databases written by earlier versions keep opening without moving data; new and reinitialised sub-indexes get the current names. `createIndex` refuses a name whose tables an earlier version's index already uses (for example `notes` next to an old `Notes`), instead of sharing them. The SQL kernel's providers (`SqlModalityProvider`) differ from `ModalityProvider`: opening is async and creates or adopts tables, and a provider drops its tables without an open instance. `createSqlIndexer` registers `"fulltext"` and `"vector"` from the dialect plus any `providers` given.

### Load actions: one module for every builder

The manifest and load-action rules live in `load-actions.ts`, called by the provider-based builder and the SQL kernel alike, so only storage differs. `planLoad(name, savedSpecs, options, providerTypes)` turns the saved sub-index specs and `getIndex`'s options into one plan per sub-index: **adopt** (open with the saved spec and data), **skip** (`{ skip: true }`: not opened, saved spec and data kept), **reinit** (`{ type, ...config }`: the saved data is dropped, the sub-index opens empty), or **missing** (no provider for the type: under `onMissingProvider: "throw"`, the default, the plan throws `Cannot load index "<name>": sub-index "<sub>" requires modality "<type>" but only [...] are registered.` before anything is touched; under `"warn"` it is kept like a skip, with a warning). `checkCreateSpec` checks a `createIndex` spec the same way (`Cannot create index "<name>": …`). An index with no sub-indexes is allowed by every builder.

### Writes are serialised

Both builders run `createIndex`, `getIndex`, `deleteIndex`, `flush` and `close` through `createSerialiser()`: each call waits for the previous one, so concurrent `getIndex` calls for one name open one instance. A failed call does not block the next.

### Index metadata

Both builders store `CreateIndexParams.metadata` in the index's manifest entry (an optional `metadata` field in its JSON), so `getIndex(name).metadata` and `getIndexNames()` return it after a reopen or reload. Manifests written before this have no `metadata` field and load as before; older versions reading a newer manifest ignore the field.

### Closing and deleting an index

`index.close()` removes the instance from its indexer (the composite's `onClose` hook), so a later `getIndex` opens a new one. The provider-based builder first keeps the closed index's manifest and serialised sub-indexes in memory, so the reopened index has its data and the next save still writes it. `indexer.deleteIndex(name)` works on a closed index too; on an open index it calls that index's own `deleteIndex()`. Both drop every sub-index the manifest names, including those skipped at open. A reinit (`getIndex(name, { subIndexes: { sub: config } })`) checks that the new type is supported before dropping the old sub-index. `close()` and `deleteIndex()` on the composite run every sub-index's step even when one throws, then rethrow (an `AggregateError` when several failed). A SQL full-text dialect may define `drop` to remove auxiliary structures with the table; DuckDB uses it for the `fts_main_<table>` schema.

### N-gram (grep) over SQL

`createSqlNgramRetriever` is the `NgramIndex` of the docs-table backends, registered by `createSqlIndexer` when the dialect has an `ngram` part (`SqlNgramDialect`). Each block is one row of `idx_<subPrefix>_ng` (`doc_id`, `block_id`, `content`, `metadata` and the dialect's store columns). A search plans the pattern (`planQuery`: the folded literals of at least 3 code points per DNF branch), selects the blocks whose store holds every literal of some branch (all blocks when a branch has none), up to 10,000 candidates (`SQL_NGRAM_CANDIDATE_BUDGET`), and verifies them in pages of 500 with the planned JavaScript regex. Hits rank by match count, ties in `(doc_id, block_id)` order; the search is truncated when the budget or `topK` left candidates unchecked. PGlite's store is a GIN-indexed `text[]` of folded trigrams (`gin`), DuckDB's a folded copy of the content scanned with `contains` (`scan`).

### Dependencies

`@statewalker/indexer-api`, `@statewalker/indexer-fulltext`, `@statewalker/indexer-vector`, `@statewalker/indexer-ngram`, and `@statewalker/db-sqlite-index` for its pure-JavaScript n-gram query planner (`planQuery`, `fold`, `trigrams`), so the SQL n-gram retriever plans and verifies patterns exactly as the SQLite backend does. No database engine dependencies.

## License

MIT
