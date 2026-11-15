import type {
  BlockId,
  DocumentPath,
  Index,
  SearchRequest,
  SearchResult,
} from "@statewalker/indexer-api";
import { describe, expect, it, vi } from "vitest";
import type { CitationBuilderFn, RerankerFn } from "../src/fn-types.js";
import { createMockCitationBuilder, createMockExpander, createMockReranker } from "../src/mock.js";
import { type BuildRequestContext, SearchPipeline } from "../src/search-pipeline.js";

/** A fake `Index` whose `search` yields fixed results and records the requests it got. */
function fakeIndex(results: SearchResult[]): Index & { requests: SearchRequest[] } {
  const requests: SearchRequest[] = [];
  const index = {
    requests,
    async *search(request: SearchRequest) {
      requests.push(request);
      for (const r of results) yield r;
    },
  };
  return index as unknown as Index & { requests: SearchRequest[] };
}

const hit = (path: DocumentPath, blockId: BlockId, score: number): SearchResult => ({
  path,
  blockId,
  score,
});

const contents: Record<string, string> = {
  "/a\u00000": "text of a",
  "/b\u00000": "text of b",
  "/c\u00001": "text of c",
};
const getContent = async (blockId: BlockId, path: DocumentPath) =>
  contents[`${path}\u0000${blockId}`];

const buildRequest = (ctx: BuildRequestContext): SearchRequest => ({
  topK: ctx.topK,
  ...(ctx.paths ? { paths: ctx.paths } : {}),
  subQueries: { ctx },
});

const contextOf = (index: { requests: SearchRequest[] }): BuildRequestContext =>
  index.requests[0]?.subQueries?.ctx as BuildRequestContext;

describe("SearchPipeline", () => {
  it("throws when no query material is given", async () => {
    const pipeline = new SearchPipeline({ index: fakeIndex([]), buildRequest });
    await expect(pipeline.execute()).rejects.toThrow(/No queries/);
  });

  it("returns retrieval order and truncates to topK", async () => {
    const index = fakeIndex([hit("/a", "0", 0.9), hit("/b", "0", 0.8), hit("/c", "1", 0.7)]);
    const entries = await new SearchPipeline({ index, buildRequest })
      .setTextQueries("q")
      .setTopK(2)
      .execute();
    expect(entries.map((e) => [e.path, e.blockId])).toEqual([
      ["/a", "0"],
      ["/b", "0"],
    ]);
    expect(contextOf(index).topK).toBe(2);
    expect(contextOf(index).lexQueries).toEqual(["q"]);
  });

  it("uses the prompt as a lexical query when the expander fails, and reports it", async () => {
    const index = fakeIndex([hit("/a", "0", 1)]);
    const onError = vi.fn();
    await new SearchPipeline({
      index,
      buildRequest,
      onError,
      expander: async () => {
        throw new Error("model down");
      },
    })
      .setPrompt("hello")
      .execute();
    expect(onError).toHaveBeenCalledWith("expansion", expect.any(Error));
    expect(contextOf(index).lexQueries).toEqual(["hello"]);
    expect(contextOf(index).vecQueries).toEqual([]);
  });

  it("drops expanded semantic queries when there is no embedFn, and reports it", async () => {
    const index = fakeIndex([hit("/a", "0", 1)]);
    const onError = vi.fn();
    const entries = await new SearchPipeline({
      index,
      buildRequest,
      onError,
      expander: createMockExpander(),
    })
      .setPrompt("x")
      .execute();
    expect(entries).toHaveLength(1);
    expect(contextOf(index).lexQueries).toEqual(["x"]);
    expect(contextOf(index).vecQueries).toEqual([]);
    expect(onError).toHaveBeenCalledWith("expansion", expect.any(Error));
  });

  it("embeds expanded semantic queries when embedFn is set", async () => {
    const index = fakeIndex([hit("/a", "0", 1)]);
    const embedFn = vi.fn(async () => new Float32Array([1, 0]));
    await new SearchPipeline({ index, buildRequest, embedFn, expander: createMockExpander() })
      .setPrompt("x")
      .execute();
    expect(contextOf(index).vecQueries).toEqual(["semantic: x"]);
    expect(contextOf(index).embeddings).toHaveLength(1);
    expect(embedFn).toHaveBeenCalledWith("semantic: x");
  });

  it("still throws for explicit semantic queries without embedFn", async () => {
    const pipeline = new SearchPipeline({ index: fakeIndex([]), buildRequest });
    await expect(pipeline.setSemanticQueries("v").execute()).rejects.toThrow(/no embedFn/);
  });

  it("reranks blocks that share a blockId in different paths without mixing them up", async () => {
    const index = fakeIndex([hit("/a", "0", 0.9), hit("/b", "0", 0.8)]);
    const seen: Array<{ blockId: BlockId; path?: DocumentPath; text: string }> = [];
    // Scores /b far above /a, so /b moves to the top.
    const reranker: RerankerFn = async (_q, candidates) => {
      seen.push(...candidates);
      return candidates.map((c) => ({
        blockId: c.blockId,
        path: c.path,
        score: c.path === "/b" ? 1 : 0,
      }));
    };
    const entries = await new SearchPipeline({
      index,
      buildRequest,
      getContent,
      reranker,
      // Rerank score only, so the order shows which entry got which score.
      blendTiers: [{ maxRank: Infinity, retrievalWeight: 0 }],
    })
      .setTextQueries("q")
      .setExplain(true)
      .execute();
    expect(seen.map((c) => c.text)).toEqual(["text of a", "text of b"]);
    expect(entries.map((e) => e.path)).toEqual(["/b", "/a"]);
    expect(entries.map((e) => e.explain?.rerankScore)).toEqual([1, 0]);
  });

  it("keeps both entries when a reranker returns blockIds without paths", async () => {
    const index = fakeIndex([hit("/a", "0", 0.9), hit("/b", "0", 0.8)]);
    const entries = await new SearchPipeline({
      index,
      buildRequest,
      getContent,
      reranker: createMockReranker(),
    })
      .setTextQueries("q")
      .execute();
    expect(entries.map((e) => e.path).sort()).toEqual(["/a", "/b"]);
  });

  it("falls back to retrieval order when the rerank content lookup fails, and reports it", async () => {
    const index = fakeIndex([hit("/a", "0", 0.9), hit("/b", "0", 0.8)]);
    const onError = vi.fn();
    const entries = await new SearchPipeline({
      index,
      buildRequest,
      onError,
      reranker: createMockReranker(),
      getContent: async () => {
        throw new Error("storage down");
      },
    })
      .setTextQueries("q")
      .execute();
    expect(entries.map((e) => e.path)).toEqual(["/a", "/b"]);
    expect(onError).toHaveBeenCalledWith("rerank", expect.any(Error));
  });

  it("falls back to retrieval order when the reranker throws, and reports it", async () => {
    const index = fakeIndex([hit("/a", "0", 0.9), hit("/b", "0", 0.8)]);
    const onError = vi.fn();
    const entries = await new SearchPipeline({
      index,
      buildRequest,
      onError,
      getContent,
      reranker: async () => {
        throw new Error("model down");
      },
    })
      .setTextQueries("q")
      .execute();
    expect(entries.map((e) => e.path)).toEqual(["/a", "/b"]);
    expect(onError).toHaveBeenCalledWith("rerank", expect.any(Error));
  });

  it("skips rerank when skip('rerank') is set", async () => {
    const index = fakeIndex([hit("/a", "0", 0.9)]);
    const reranker = vi.fn(createMockReranker());
    await new SearchPipeline({ index, buildRequest, getContent, reranker })
      .setTextQueries("q")
      .skip("rerank")
      .execute();
    expect(reranker).not.toHaveBeenCalled();
  });

  it("gives each entry the citation of its own path when blockIds repeat", async () => {
    const index = fakeIndex([hit("/a", "0", 0.9), hit("/b", "0", 0.8)]);
    const entries = await new SearchPipeline({
      index,
      buildRequest,
      getContent,
      citationBuilder: createMockCitationBuilder(),
    })
      .setTextQueries("q")
      .execute();
    expect(entries.map((e) => [e.path, e.citation?.snippet])).toEqual([
      ["/a", "text of a"],
      ["/b", "text of b"],
    ]);
  });

  it("matches path-less citations to entries in order when blockIds repeat", async () => {
    const index = fakeIndex([hit("/a", "0", 0.9), hit("/b", "0", 0.8)]);
    // A builder that ignores paths: looks content up by blockId only and returns no path.
    const citationBuilder: CitationBuilderFn = async (_q, results, lookup) =>
      Promise.all(
        results.map(async (r) => ({
          blockId: r.blockId,
          snippet: await lookup(r.blockId),
          relevance: r.score,
        })),
      );
    const entries = await new SearchPipeline({ index, buildRequest, getContent, citationBuilder })
      .setTextQueries("q")
      .execute();
    expect(entries.map((e) => e.citation?.snippet)).toEqual(["text of a", "text of a"]);
    expect(entries.every((e) => e.citation !== undefined)).toBe(true);
  });

  it("returns entries without citations when the citation builder throws, and reports it", async () => {
    const index = fakeIndex([hit("/a", "0", 0.9)]);
    const onError = vi.fn();
    const entries = await new SearchPipeline({
      index,
      buildRequest,
      getContent,
      onError,
      citationBuilder: async () => {
        throw new Error("boom");
      },
    })
      .setTextQueries("q")
      .execute();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.citation).toBeUndefined();
    expect(onError).toHaveBeenCalledWith("citations", expect.any(Error));
  });

  it("passes the paths to buildRequest", async () => {
    const index = fakeIndex([]);
    await new SearchPipeline({ index, buildRequest })
      .setPaths("/docs/")
      .setTextQueries("q")
      .execute();
    expect(contextOf(index).paths).toEqual(["/docs/"]);
  });
});
