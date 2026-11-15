// =============================================================================
// Indexer Contract — Generic name-bound access handle
//
// The modality packages (`indexer-fulltext`, `indexer-vector`, `indexer-ngram`,
// ...) each expose a typed handle bound to one sub-index name. They differ only
// in the modality `type` and their config helpers, so the handle is built here
// once; each modality's `new…Access(name)` is a thin wrapper.
// =============================================================================

import type { CreateIndexParams } from "../indexer.js";
import { getSubQuery, getSubResult, setSubQuery } from "./helpers.js";
import type { Index } from "./index.js";
import type { SearchRequest, SearchResult } from "./types.js";

/**
 * Typed bundle bound to one sub-index **name**: typed read/write for the
 * sub-index, its config, sub-query and sub-result, all under the bound name.
 * Returned by {@link newSubIndexAccess}.
 *
 * The handle does NOT know about Providers and does NOT auto-initialise
 * (`get` throws if the named sub-index isn't registered).
 */
export interface SubIndexAccess<TIndex, TConfig, TQuery, TResult> {
  /** The sub-index name this access is bound to. */
  readonly name: string;
  /**
   * Read the sub-index registered under this name on `index`. Throws if no such
   * binding exists, or if it is of another modality type.
   */
  get(index: Index): TIndex;
  /** Like {@link get} but returns `undefined` instead of throwing — for probing. */
  tryGet(index: Index): TIndex | undefined;

  /** Write the creation config for this name in `params.subIndexes`. */
  setConfig(params: CreateIndexParams, config: TConfig): void;
  /** Read the creation config for this name from `params`, if any. */
  getConfig(params: CreateIndexParams): TConfig | undefined;

  /** Write the sub-query for this name on `request`. */
  setQuery(request: SearchRequest, query: TQuery): void;
  /** Read the sub-query for this name from `request`, if any. */
  getQuery(request: SearchRequest): TQuery | undefined;

  /** Read the sub-result for this name on `entry`, if any. */
  getResult(entry: SearchResult): TResult | undefined;
}

/** What a modality supplies to {@link newSubIndexAccess}. */
export interface SubIndexAccessOptions<TConfig> {
  /** The modality type a binding must carry (e.g. `"fulltext"`). */
  type: string;
  /** Write the modality's config under `name` in `params.subIndexes`. */
  setConfig(params: CreateIndexParams, name: string, config: TConfig): void;
  /** Read the modality's config under `name` from `params`, if any. */
  getConfig(params: CreateIndexParams, name: string): TConfig | undefined;
}

/** Construct a name-bound {@link SubIndexAccess} handle for one modality. */
export function newSubIndexAccess<TIndex, TConfig, TQuery, TResult>(
  name: string,
  options: SubIndexAccessOptions<TConfig>,
): SubIndexAccess<TIndex, TConfig, TQuery, TResult> {
  const { type, setConfig, getConfig } = options;
  return {
    name,
    get(index: Index): TIndex {
      const binding = index.getBinding(name);
      if (!binding) {
        throw new Error(`No sub-index named "${name}" is registered on index "${index.name}"`);
      }
      if (binding.type !== type) {
        throw new Error(
          `Sub-index "${name}" on index "${index.name}" is of type "${binding.type}", not "${type}"`,
        );
      }
      return binding.index as TIndex;
    },
    tryGet(index: Index): TIndex | undefined {
      const binding = index.getBinding(name);
      return binding?.type === type ? (binding.index as TIndex) : undefined;
    },
    setConfig(params: CreateIndexParams, config: TConfig): void {
      setConfig(params, name, config);
    },
    getConfig(params: CreateIndexParams): TConfig | undefined {
      return getConfig(params, name);
    },
    setQuery(request: SearchRequest, query: TQuery): void {
      setSubQuery<TQuery>(request, name, query);
    },
    getQuery(request: SearchRequest): TQuery | undefined {
      return getSubQuery<TQuery>(request, name);
    },
    getResult(entry: SearchResult): TResult | undefined {
      return getSubResult<TResult>(entry, name);
    },
  };
}
