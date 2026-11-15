// @statewalker/indexer-core — code shared by the @statewalker/indexer-* backends: composite index,
// RRF, and the persistence-backed and SQL indexer builders. Published to npm for backend authors.

export { toAsyncIterable } from "./async.js";
export { compositeKey } from "./composite-key.js";
export { type CompositeIndexOptions, createCompositeIndex } from "./create-composite-index.js";
export {
  createPersistenceBackedIndexer,
  type PersistenceBackedIndexerOptions,
} from "./create-persistence-backed-indexer.js";
export {
  createSqlFtsRetriever,
  type SqlFtsDialect,
  type SqlFtsRetrieverOptions,
} from "./create-sql-fts-retriever.js";
export {
  createSqlIndexer,
  type SqlBackedDialect,
  type SqlDocsContext,
  type SqlDocsModalityProvider,
  type SqlIndexerOptions,
} from "./create-sql-indexer.js";
export {
  createSqlNgramRetriever,
  foldNgramText,
  ngramTrigrams,
  SQL_NGRAM_CANDIDATE_BUDGET,
  type SqlNgramDialect,
  type SqlNgramRetrieverOptions,
} from "./create-sql-ngram-retriever.js";
export {
  createSqlVectorRetriever,
  type SqlVectorDialect,
  type SqlVectorRetrieverOptions,
} from "./create-sql-vector-retriever.js";
export {
  checkCreateSpec,
  type LoadPlan,
  missingProviderError,
  planLoad,
  type SubIndexPlan,
  type SubIndexSpec,
} from "./load-actions.js";
export { matchesPrefix } from "./path-prefix.js";
export { readEntryBytes, singleChunk, toBytes } from "./persistence-bytes.js";
export { type RankedList, reciprocalRankFusion } from "./rrf.js";
export { createSerialiser } from "./run-exclusive.js";
export { legacySanitizePrefix, sanitizePrefix } from "./sanitize-prefix.js";
export type { SqlDb } from "./sql-db.js";
export {
  createSqlKernelIndexer,
  type SavedIndex,
  type SqlKernelOptions,
  type SqlKernelStorage,
  type SqlKernelSubIndex,
  type SqlModalityProvider,
} from "./sql-kernel.js";
export {
  buildPathPrefixesSql,
  buildPathPrefixSql,
  escapeLikePattern,
  type PathPrefixSql,
} from "./sql-path-prefix.js";
export {
  buildSearchFilterSql,
  embeddingToLiteral,
  ISO_639_1_LANGUAGE_NAMES,
  type SearchFilterSql,
} from "./sql-search.js";
export {
  legacySqlTableNaming,
  SQL_MAX_INDEX_PREFIX,
  SQL_MAX_SUB_INDEX_PREFIX,
  type SqlTableNaming,
  sqlDocsTableName,
  sqlFtsTableName,
  sqlNgramTableName,
  sqlTableNaming,
  sqlVectorIndexName,
  sqlVectorTableName,
} from "./sql-table-names.js";
export { validateDimensionality } from "./validate-dimensionality.js";
