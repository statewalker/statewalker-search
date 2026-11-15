import type { BlockId, DocumentPath, ScoredItem } from "@statewalker/indexer-api";
import type {
  Citation,
  CitationBuilderFn,
  ExpandedQuery,
  QueryExpanderFn,
  RerankCandidate,
  RerankerFn,
  RerankScore,
} from "./fn-types.js";

export function createMockExpander(): QueryExpanderFn {
  return async (
    query: string,
    options?: { intent?: string; maxVariations?: number },
  ): Promise<ExpandedQuery[]> => {
    const max = options?.maxVariations ?? 2;
    const results: ExpandedQuery[] = [{ type: "lex", query }];
    if (max >= 2) {
      results.push({ type: "vec", query: `semantic: ${query}` });
    }
    if (max >= 3 && options?.intent) {
      results.push({
        type: "hyde",
        query: `Hypothetical answer about ${query} in context of ${options.intent}`,
      });
    }
    return results.slice(0, max);
  };
}

export function createMockReranker(scoreMap?: Map<BlockId, number>): RerankerFn {
  return async (
    _query: string,
    candidates: RerankCandidate[],
    options?: { topK?: number },
  ): Promise<RerankScore[]> => {
    const results: RerankScore[] = candidates.map((c, i) => ({
      blockId: c.blockId,
      ...(c.path ? { path: c.path } : {}),
      score: scoreMap?.get(c.blockId) ?? 1 / (i + 1),
    }));
    results.sort((a, b) => b.score - a.score);
    return options?.topK ? results.slice(0, options.topK) : results;
  };
}

export function createMockCitationBuilder(): CitationBuilderFn {
  return async (
    query: string,
    results: Array<ScoredItem & { path?: DocumentPath }>,
    getContent: (blockId: BlockId, path?: DocumentPath) => Promise<string>,
    options?: { maxCitations?: number },
  ): Promise<Citation[]> => {
    const max = options?.maxCitations ?? 3;
    const citations: Citation[] = [];
    for (const r of results.slice(0, max)) {
      const content = await getContent(r.blockId, r.path);
      citations.push({
        blockId: r.blockId,
        ...(r.path ? { path: r.path } : {}),
        snippet: content.slice(0, 100),
        relevance: r.score,
        context: `Result for query "${query}"`,
      });
    }
    return citations;
  };
}
