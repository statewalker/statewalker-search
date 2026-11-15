import type {
  CreateIndexParams,
  Index,
  SearchRequest,
  SearchResult,
} from "@statewalker/indexer-api";
import { newSubIndexAccess } from "@statewalker/indexer-api";
import { getFullTextConfig, setFullTextConfig } from "./config.js";
import type { FullTextConfig, FullTextIndex, FulltextQuery, FulltextResult } from "./types.js";
import { FULL_TEXT_TYPE } from "./types.js";

/**
 * User-facing typed bundle bound to one sub-index **name**, returned by
 * {@link newFullTextAccess}. Exposes typed read/write for the sub-index, its
 * config, sub-query, and sub-result — all under the bound name.
 *
 * The handle does NOT know about Providers (those are backend wiring) and does
 * NOT auto-initialise (`get` throws if the named sub-index isn't registered).
 */
export interface FullTextAccess {
  /** The sub-index name this access is bound to. */
  readonly name: string;
  /**
   * Read the FullTextIndex registered under this name on `index`. Throws if no
   * such binding exists (or it isn't a full-text sub-index).
   */
  get(index: Index): FullTextIndex;
  /** Like {@link get} but returns `undefined` instead of throwing — for probing. */
  tryGet(index: Index): FullTextIndex | undefined;

  /** Write the full-text creation config for this name in `params.subIndexes`. */
  setConfig(params: CreateIndexParams, config: FullTextConfig): void;
  /** Read the full-text creation config for this name from `params`, if any. */
  getConfig(params: CreateIndexParams): FullTextConfig | undefined;

  /** Write the full-text sub-query for this name on `request`. */
  setQuery(request: SearchRequest, query: FulltextQuery): void;
  /** Read the full-text sub-query for this name from `request`, if any. */
  getQuery(request: SearchRequest): FulltextQuery | undefined;

  /** Read the full-text sub-result for this name on `entry`, if any. */
  getResult(entry: SearchResult): FulltextResult | undefined;
}

/** Construct a name-bound {@link FullTextAccess} handle. */
export function newFullTextAccess(name: string): FullTextAccess {
  return newSubIndexAccess<FullTextIndex, FullTextConfig, FulltextQuery, FulltextResult>(name, {
    type: FULL_TEXT_TYPE,
    setConfig: setFullTextConfig,
    getConfig: getFullTextConfig,
  });
}
