import type { FullTextBlock, FullTextIndexInfo } from "@statewalker/indexer-fulltext";
import { type MemFullTextEngine, MemFullTextIndex, type RankedKey } from "@statewalker/indexer-mem";
import FlexSearch, { type Index as FlexIndex } from "flexsearch";

function newFlexIndex(): FlexIndex {
  return new FlexSearch.Index({ tokenize: "forward", resolution: 9, cache: true });
}

/**
 * FlexSearch adapter for the in-memory block store. FlexSearch ids are
 * numbers, so the adapter keeps a store-key ↔ number map; it is part of the
 * exported state (`chunks`, `keyToNum`, `nextNum`).
 */
class FlexSearchEngine implements MemFullTextEngine {
  private flexIndex = newFlexIndex();
  private keyToNum = new Map<string, number>();
  private numToKey = new Map<number, string>();
  private nextNum = 1;

  add(key: string, block: FullTextBlock): void {
    let num = this.keyToNum.get(key);
    if (num === undefined) {
      num = this.nextNum++;
      this.keyToNum.set(key, num);
      this.numToKey.set(num, key);
    }
    this.flexIndex.add(num, block.content);
  }

  remove(key: string): void {
    const num = this.keyToNum.get(key);
    if (num === undefined) return;
    this.flexIndex.remove(num);
    this.keyToNum.delete(key);
    this.numToKey.delete(num);
  }

  search(query: string, limit: number): RankedKey[] {
    // `suggest: true` relaxes the default all-terms-AND for a multi-word query into a
    // ranked partial match — sections are ordered by how much of the term set they match
    // (FlexSearch's own resolution scoring), instead of returning nothing unless one
    // section contains every term. For single-word or fully-intersecting queries it is
    // identical to the default, so it only ever broadens recall, never narrows it.
    // Over-fetch (×3) so path filtering in the store still leaves `limit` hits.
    const ids = this.flexIndex.search(query, limit * 3, { suggest: true }) as number[];
    const hits: RankedKey[] = [];
    ids.forEach((num, rank) => {
      const key = this.numToKey.get(num);
      if (key !== undefined) hits.push({ key, score: 1 - rank / ids.length });
    });
    return hits;
  }

  exportState(): Record<string, unknown> {
    const chunks: Record<string, string> = {};
    this.flexIndex.export((key: string | number, data: string) => {
      chunks[String(key)] = data;
    });
    return { chunks, keyToNum: [...this.keyToNum.entries()], nextNum: this.nextNum };
  }

  static restore(state: Record<string, unknown>): FlexSearchEngine {
    const engine = new FlexSearchEngine();
    const chunks = (state.chunks ?? {}) as Record<string, string>;
    for (const [key, data] of Object.entries(chunks)) engine.flexIndex.import(key, data);
    for (const [key, num] of (state.keyToNum ?? []) as Array<[string, number]>) {
      engine.keyToNum.set(key, num);
      engine.numToKey.set(num, key);
    }
    engine.nextNum = typeof state.nextNum === "number" ? state.nextNum : engine.keyToNum.size + 1;
    return engine;
  }
}

/**
 * In-memory full-text sub-index backed by FlexSearch: a FlexSearch adapter
 * over the shared in-memory block store ({@link MemFullTextIndex}).
 */
export class FlexSearchFullTextIndex extends MemFullTextIndex {
  constructor(info: FullTextIndexInfo) {
    super(info, "FlexSearchFullTextIndex", new FlexSearchEngine());
  }

  protected restoreEngine(state: Record<string, unknown>): MemFullTextEngine {
    return FlexSearchEngine.restore(state);
  }

  /**
   * Serialize to a JSON string (format version 3). Cached: while the index is
   * unchanged, returns the same string without exporting FlexSearch again.
   */
  async serialize(): Promise<string> {
    return this.serializeState();
  }

  /** Deserialize from JSON (format version 3); throws on any other version. */
  static deserialize(info: FullTextIndexInfo, json: string): FlexSearchFullTextIndex {
    const index = new FlexSearchFullTextIndex(info);
    index.restoreState(json);
    return index;
  }
}
