// =============================================================================
// RRF-blending conformance suite — composite Index score semantics.
//
// Asserts the two contract guarantees from D4 / D5 in the design:
//
//   1. `Index.search` score is *always* the RRF fusion position, even for a
//      single active sub-stream. Native scores live on each binding's
//      sub-result under its name.
//   2. A sub-query's own `topK` overrides the top-level retrieval depth for
//      that sub-index; the composite still truncates the fused output to the
//      top-level `topK`.
//
// The suite is parameterised by a `factory` and a callback that, given an open
// `Index`, returns the population + the sub-query payload to feed it. Each
// backend supplies a callback that fits its modality wiring.
// =============================================================================

import {
  getSubResult,
  type Index,
  type ScoredHit,
  type SearchRequest,
} from "@statewalker/indexer-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collect } from "./test-utils.js";
import type { IndexerFactory } from "./types.js";

export interface RrfSuiteOptions {
  factory: IndexerFactory;
  /**
   * Sub-index config used for the single-modality RRF + topK-override tests.
   * Must carry `type` and modality-specific fields. The suite registers it
   * under the name `"q"`.
   */
  config: { type: string } & Record<string, unknown>;
  /**
   * Populate the registered sub-index with three blocks whose blockIds are
   * `a`, `b`, `c`, each on its own path `/d/a`, `/d/b`, `/d/c`. The Provider
   * decides how to source content / embeddings; the suite only checks ids.
   */
  populate(index: Index): Promise<void>;
  /**
   * Build a sub-query payload that retrieves all three blocks for the bound
   * sub-index name. `topK` may be passed by the suite; the callback must honour
   * it on its sub-query if supplied.
   */
  buildQuery(opts: { topK?: number }): unknown;
}

export function runRrfBlendingSuite(name: string, options: RrfSuiteOptions): void {
  const { factory, config, populate, buildQuery } = options;

  describe(`${name} — RRF blending`, () => {
    let indexer: Awaited<ReturnType<typeof factory.create>>;
    let index: Awaited<ReturnType<typeof indexer.createIndex>>;

    beforeEach(async () => {
      indexer = await factory.create();
      index = await indexer.createIndex({
        name: "rrf-test",
        subIndexes: { q: config },
      });
      await populate(index);
      await indexer.flush();
    });

    afterEach(async () => {
      try {
        await indexer.close();
      } catch {
        /* */
      }
      await factory.cleanup?.();
    });

    it("single-active-sub-index search returns RRF fusion scores, not native pass-through", async () => {
      const request: SearchRequest = {
        topK: 10,
        subQueries: { q: buildQuery({}) },
      };
      const results = await collect(index.search(request));
      expect(results.length).toBeGreaterThan(0);
      // RRF score for rank i is 1 / (k + (i+1)) with k = 60 in the core impl;
      // all scores will be < 1 and strictly decreasing across distinct ranks.
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.score).toBeLessThan(1);
        expect(r.score).toBeGreaterThan(0);
        // Not native pass-through: the fused score differs from the sub-index's own score.
        expect(r.score).not.toBe(getSubResult<ScoredHit>(r, "q")?.score);
      }
      // One list fuses to strictly decreasing scores, rank by rank.
      for (let i = 1; i < results.length; i++) {
        expect(results[i]?.score).toBeLessThan(results[i - 1]?.score ?? Infinity);
      }
      // Sub-result for the single active name carries the native score.
      const first = results[0];
      if (!first) throw new Error("expected at least one result");
      const subFirst = getSubResult<ScoredHit>(first, "q");
      expect(subFirst).toBeDefined();
      expect(typeof subFirst?.score).toBe("number");
    });

    it("per-sub-query topK controls retrieval depth; fused output truncates to top-level topK", async () => {
      // Sub-query asks for topK 2, top-level asks for 5 — only 2 hits possible.
      const request: SearchRequest = {
        topK: 5,
        subQueries: { q: buildQuery({ topK: 2 }) },
      };
      const results = await collect(index.search(request));
      expect(results).toHaveLength(2);
    });

    it("top-level topK truncates the fused output", async () => {
      const request: SearchRequest = {
        topK: 1,
        subQueries: { q: buildQuery({}) },
      };
      const results = await collect(index.search(request));
      expect(results).toHaveLength(1);
    });

    it("top-level paths scope a sub-query that sets no paths of its own", async () => {
      const request: SearchRequest = {
        topK: 10,
        paths: ["/d/a"],
        subQueries: { q: buildQuery({}) },
      };
      const results = await collect(index.search(request));
      expect(results.map((r) => r.path)).toEqual(["/d/a"]);
    });

    it("a sub-query's own paths override the top-level paths", async () => {
      const sub = { ...(buildQuery({}) as Record<string, unknown>), paths: ["/d/b"] };
      const request: SearchRequest = { topK: 10, paths: ["/d/a"], subQueries: { q: sub } };
      const results = await collect(index.search(request));
      expect(results.map((r) => r.path)).toEqual(["/d/b"]);
    });
  });
}
