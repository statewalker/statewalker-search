import type { BlockId, DocumentPath, ScoredItem } from "@statewalker/indexer-api";
import type { QueryType } from "./utils/query-parser.js";

export interface ExpandedQuery {
  type: QueryType;
  query: string;
}

export interface Citation {
  blockId: BlockId;
  /**
   * Document of the cited block. Block ids are unique only within a document, so set it
   * when the builder has it (the entries passed to the builder carry it); without it the
   * pipeline matches citations to entries by `blockId` in result order.
   */
  path?: DocumentPath;
  snippet: string;
  relevance: number;
  context?: string;
}

export type QueryExpanderFn = (
  query: string,
  options?: {
    intent?: string;
    maxVariations?: number;
  },
) => Promise<ExpandedQuery[]>;

/** A block to rerank: its reference and its text. */
export interface RerankCandidate {
  blockId: BlockId;
  /** Document of the block; set by `SearchPipeline`. */
  path?: DocumentPath;
  text: string;
}

/**
 * A reranker's score for one candidate, expected in `[0, 1]` (higher is better):
 * `blendWithReranker` mixes it with a `1 / rank` retrieval score in that range, so a reranker
 * with unbounded scores (logits) should squash them first, for example with a sigmoid. Echo the candidate's `path`: block ids are unique only
 * within a document, and without it the pipeline matches scores to candidates by `blockId` in
 * candidate order.
 */
export interface RerankScore extends ScoredItem {
  path?: DocumentPath;
}

export type RerankerFn = (
  query: string,
  candidates: RerankCandidate[],
  options?: { topK?: number },
) => Promise<RerankScore[]>;

/**
 * Builds citations for the results. `SearchPipeline` passes its entries, which carry `path`;
 * pass it on to `getContent` and set it on each citation, since block ids are unique only within
 * a document.
 */
export type CitationBuilderFn = (
  query: string,
  results: Array<ScoredItem & { path?: DocumentPath }>,
  getContent: (blockId: BlockId, path?: DocumentPath) => Promise<string>,
  options?: { maxCitations?: number },
) => Promise<Citation[]>;
