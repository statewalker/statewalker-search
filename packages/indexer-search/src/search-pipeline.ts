// =============================================================================
// SearchPipeline — app-side orchestrator over an `Index`.
//
// Stages: EXPAND (prompt → typed queries) → EMBED (semantic queries) → SEARCH
// (caller-built `SearchRequest` → `Index.search` → `SearchResult` stream) →
// RERANK (optional; uses caller-supplied content lookup) → CITE (optional).
//
// The pipeline is modality-agnostic: it does not know "fulltext" or "vector".
// The caller supplies a `buildRequest` callback that turns the orchestrated
// query material (lex queries, vec queries, embeddings) into a `SearchRequest`
// with `subQueries` populated under the caller-chosen sub-index names. The
// caller likewise supplies `getContent` for content lookups used by the rerank
// and citation stages.
// =============================================================================

import type {
  BlockId,
  DocumentPath,
  EmbedFn,
  Index,
  SearchRequest,
  SearchResult,
} from "@statewalker/indexer-api";
import type {
  Citation,
  CitationBuilderFn,
  ExpandedQuery,
  QueryExpanderFn,
  RerankerFn,
} from "./fn-types.js";
import { type BlendTier, blendWithReranker } from "./reranker-blend.js";

export type PipelineErrorStage = "expansion" | "rerank" | "citations";

/**
 * Context handed to {@link PipelineConfig.buildRequest}. Carries the assembled
 * query material plus the pipeline's `paths`/`topK` defaults.
 */
export interface BuildRequestContext {
  paths?: DocumentPath[];
  topK: number;
  prompt?: string;
  lexQueries: string[];
  vecQueries: string[];
  embeddings: Float32Array[];
}

/** Content lookup callback used by the rerank and citation stages. */
export type GetContentFn = (blockId: BlockId, path: DocumentPath) => Promise<string | undefined>;

export interface PipelineConfig {
  index: Index;
  /** Build the modality-agnostic `SearchRequest` for `Index.search`. */
  buildRequest: (ctx: BuildRequestContext) => SearchRequest;
  /** Required only when the rerank or citation stages run. */
  getContent?: GetContentFn;
  /** Required only when semantic queries are supplied. */
  embedFn?: EmbedFn;
  expander?: QueryExpanderFn;
  reranker?: RerankerFn;
  citationBuilder?: CitationBuilderFn;
  blendTiers?: BlendTier[];
  /**
   * Invoked when an optional stage (`expansion`, `rerank`, or `citations`) throws.
   * When supplied, the pipeline calls this before falling back to the documented
   * degradation behaviour. When omitted, errors are silently swallowed and the
   * pipeline still produces results from the surviving stages.
   */
  onError?: (stage: PipelineErrorStage, error: unknown) => void;
}

export interface EntryExplain {
  expandedQueries: ExpandedQuery[];
  retrievalScore: number;
  rerankScore?: number;
  blendedScore: number;
}

export interface PipelineEntry {
  blockId: string;
  path: DocumentPath;
  score: number;
  citation?: Citation;
  explain?: EntryExplain;
}

type SkipStage = "expansion" | "rerank" | "citations";

export class SearchPipeline {
  private readonly config: PipelineConfig;
  private _paths?: DocumentPath[];
  private _prompt?: string;
  private _textQueries: string[] = [];
  private _semanticQueries: string[] = [];
  private _embeddings: Float32Array[] = [];
  private _topK = 10;
  private _explain = false;
  private _reranker?: RerankerFn;
  private readonly _skip = new Set<SkipStage>();

  constructor(config: PipelineConfig) {
    this.config = config;
  }

  setPaths(...paths: DocumentPath[]): this {
    this._paths = paths;
    return this;
  }

  setPrompt(prompt: string): this {
    this._prompt = prompt;
    return this;
  }

  setTextQueries(...queries: string[]): this {
    this._textQueries = queries;
    return this;
  }

  setSemanticQueries(...queries: string[]): this {
    this._semanticQueries = queries;
    return this;
  }

  setEmbeddings(...embeddings: Float32Array[]): this {
    this._embeddings = embeddings;
    return this;
  }

  setTopK(topK: number): this {
    this._topK = topK;
    return this;
  }

  setExplain(explain: boolean): this {
    this._explain = explain;
    return this;
  }

  setReranker(reranker: RerankerFn): this {
    this._reranker = reranker;
    return this;
  }

  skip(stage: SkipStage): this {
    this._skip.add(stage);
    return this;
  }

  async execute(): Promise<PipelineEntry[]> {
    const { index, embedFn, buildRequest, getContent, blendTiers, onError } = this.config;
    const expander = !this._skip.has("expansion") ? this.config.expander : undefined;
    const reranker = !this._skip.has("rerank")
      ? (this._reranker ?? this.config.reranker)
      : undefined;
    const citationBuilder = !this._skip.has("citations") ? this.config.citationBuilder : undefined;

    // 1. EXPAND — resolve prompt into typed queries
    let expandedQueries: ExpandedQuery[] = [];
    const lexQueries: string[] = [...this._textQueries];
    const vecQueries: string[] = [...this._semanticQueries];
    const precomputedEmbeddings: Float32Array[] = [...this._embeddings];

    if (this._prompt) {
      if (expander) {
        try {
          expandedQueries = await expander(this._prompt);
          const dropped: string[] = [];
          for (const eq of expandedQueries) {
            if (eq.type === "lex") {
              lexQueries.push(eq.query);
            } else if (embedFn) {
              vecQueries.push(eq.query);
            } else {
              dropped.push(eq.query);
            }
          }
          if (dropped.length > 0) {
            // Without an embedder, semantic expansions cannot be searched: drop them and report,
            // like the fallback path below, rather than fail the whole search.
            onError?.(
              "expansion",
              new Error(
                `Dropped ${dropped.length} semantic expanded queries: no embedFn in pipeline config`,
              ),
            );
          }
          if (lexQueries.length === 0 && vecQueries.length === 0) {
            lexQueries.push(this._prompt);
          }
        } catch (err) {
          onError?.("expansion", err);
          lexQueries.push(this._prompt);
          if (embedFn) {
            vecQueries.push(this._prompt);
          }
        }
      } else {
        lexQueries.push(this._prompt);
        if (embedFn) {
          vecQueries.push(this._prompt);
        }
      }
    }

    if (lexQueries.length === 0 && vecQueries.length === 0 && precomputedEmbeddings.length === 0) {
      throw new Error("No queries, embeddings, or prompt provided to SearchPipeline");
    }

    if (vecQueries.length > 0 && !embedFn) {
      throw new Error("Semantic queries provided but no embedFn in pipeline config");
    }

    // 2. EMBED semantic queries
    const embeddings: Float32Array[] = [...precomputedEmbeddings];
    if (embedFn && vecQueries.length > 0) {
      const embedded = await Promise.all(vecQueries.map((q) => embedFn(q)));
      embeddings.push(...embedded);
    }

    // 3. SEARCH — let the caller turn query material into a SearchRequest
    const request = buildRequest({
      paths: this._paths,
      topK: this._topK,
      prompt: this._prompt,
      lexQueries,
      vecQueries,
      embeddings,
    });

    const results: SearchResult[] = [];
    for await (const r of index.search(request)) {
      results.push(r);
    }

    let entries: PipelineEntry[] = results.map((r) => ({
      blockId: r.blockId,
      path: r.path,
      score: r.score,
      ...(this._explain
        ? {
            explain: {
              expandedQueries,
              retrievalScore: r.score,
              blendedScore: r.score,
            },
          }
        : {}),
    }));

    // 4. RERANK — optional; needs `getContent` to fetch block text.
    if (reranker && entries.length > 0 && getContent) {
      const queryForRerank = this._prompt ?? lexQueries[0] ?? vecQueries[0] ?? "";
      try {
        const texts = await Promise.all(
          entries.map(async (e) => (await getContent(e.blockId, e.path)) ?? ""),
        );
        const candidates = entries.map((e, i) => ({
          blockId: e.blockId,
          path: e.path,
          text: texts[i] ?? "",
        }));
        const rerankResults = await reranker(queryForRerank, candidates);
        // Block ids are unique only within a document: match each score to its entry by
        // path + blockId, and blend on positional keys so equal block ids never collide.
        const matched = matchToEntries(entries, rerankResults);
        const rerankScores = new Map<string, number>();
        for (const [i, r] of matched) rerankScores.set(String(i), r.score);
        const blended = blendWithReranker(
          entries.map((e, i) => ({ blockId: String(i), score: e.score })),
          rerankScores,
          blendTiers,
        );
        const current = entries;
        entries = blended.map((r) => {
          const existing = current[Number(r.blockId)] as PipelineEntry;
          return {
            blockId: existing.blockId,
            path: existing.path,
            score: r.score,
            ...(this._explain && existing.explain
              ? {
                  explain: {
                    ...existing.explain,
                    rerankScore: rerankScores.get(r.blockId),
                    blendedScore: r.score,
                  },
                }
              : {}),
          };
        });
      } catch (err) {
        onError?.("rerank", err);
        // Fall back to retrieval ordering — `entries` is unchanged.
      }
    }

    // 5. CITE — optional; needs `getContent` to fetch block text.
    if (citationBuilder && entries.length > 0 && getContent) {
      const queryForCite = this._prompt ?? lexQueries[0] ?? vecQueries[0] ?? "";
      try {
        const citations = await citationBuilder(queryForCite, entries, async (blockId, path) => {
          const entry = path
            ? entries.find((e) => e.blockId === blockId && e.path === path)
            : entries.find((e) => e.blockId === blockId);
          if (!entry) return "";
          return (await getContent(blockId, entry.path)) ?? "";
        });
        for (const [i, cit] of matchToEntries(entries, citations)) {
          (entries[i] as PipelineEntry).citation = cit;
        }
      } catch (err) {
        onError?.("citations", err);
        // Fall back to entries without citations.
      }
    }

    return entries.slice(0, this._topK);
  }
}

/**
 * Pairs items returned by a stage (rerank scores, citations) with the entries they belong to.
 * An item with a `path` matches the entry with the same path and blockId; an item without one
 * matches the first entry with its blockId that no earlier item took, so two documents that
 * share a block id each keep one item. Items that match no entry are dropped.
 */
function matchToEntries<T extends { blockId: BlockId; path?: DocumentPath }>(
  entries: PipelineEntry[],
  items: T[],
): Map<number, T> {
  const matched = new Map<number, T>();
  for (const item of items) {
    const i = entries.findIndex(
      (e, j) =>
        !matched.has(j) &&
        e.blockId === item.blockId &&
        (item.path === undefined || e.path === item.path),
    );
    if (i >= 0) matched.set(i, item);
  }
  return matched;
}
