import type {
  CreateIndexParams,
  Index,
  SearchRequest,
  SearchResult,
} from "@statewalker/indexer-api";
import { newSubIndexAccess } from "@statewalker/indexer-api";
import { getNgramConfig, setNgramConfig } from "./config.js";
import type { NgramConfig, NgramIndex, NgramQuery, NgramResult } from "./types.js";
import { NGRAM_TYPE } from "./types.js";

/** User-facing typed bundle bound to one n-gram sub-index **name**. */
export interface NgramAccess {
  readonly name: string;
  /** Throws if no n-gram sub-index named `name` is registered on `index`. */
  get(index: Index): NgramIndex;
  tryGet(index: Index): NgramIndex | undefined;
  setConfig(params: CreateIndexParams, config: NgramConfig): void;
  getConfig(params: CreateIndexParams): NgramConfig | undefined;
  setQuery(request: SearchRequest, query: NgramQuery): void;
  getQuery(request: SearchRequest): NgramQuery | undefined;
  getResult(entry: SearchResult): NgramResult | undefined;
}

export function newNgramAccess(name: string): NgramAccess {
  return newSubIndexAccess<NgramIndex, NgramConfig, NgramQuery, NgramResult>(name, {
    type: NGRAM_TYPE,
    setConfig: setNgramConfig,
    getConfig: getNgramConfig,
  });
}
