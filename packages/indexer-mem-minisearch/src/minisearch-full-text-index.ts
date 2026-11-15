import type { FullTextBlock, FullTextIndexInfo } from "@statewalker/indexer-fulltext";
import { type MemFullTextEngine, MemFullTextIndex, type RankedKey } from "@statewalker/indexer-mem";
import MiniSearch from "minisearch";

const MINISEARCH_OPTIONS = { fields: ["content"], idField: "key" };

/**
 * MiniSearch adapter for the in-memory block store. Exported state:
 * `miniSearch` (MiniSearch's own JSON) and `keys` (the indexed keys, kept for
 * readers of format 3 that rebuild their key set from it).
 */
class MiniSearchEngine implements MemFullTextEngine {
  private miniSearch: MiniSearch;
  private keys = new Set<string>();

  constructor(miniSearch = new MiniSearch(MINISEARCH_OPTIONS)) {
    this.miniSearch = miniSearch;
  }

  add(key: string, block: FullTextBlock): void {
    this.miniSearch.add({ key, content: block.content });
    this.keys.add(key);
  }

  remove(key: string): void {
    if (!this.keys.delete(key)) return;
    this.miniSearch.discard(key);
  }

  search(query: string, _limit: number): RankedKey[] {
    let results = this.miniSearch.search(query, { prefix: true, fuzzy: 0.2 });
    if (results.length === 0) {
      results = this.miniSearch.search(query, { prefix: true });
    }
    if (results.length === 0) {
      const words = query.split(/\s+/).filter((w) => w.length > 1);
      if (words.length > 1) {
        results = this.miniSearch.search(query, { prefix: true, fuzzy: 0.2, combineWith: "OR" });
      }
    }
    return results.map((r) => ({ key: r.id as string, score: r.score }));
  }

  exportState(): Record<string, unknown> {
    return { miniSearch: this.miniSearch.toJSON(), keys: [...this.keys] };
  }

  static restore(state: Record<string, unknown>): MiniSearchEngine {
    const engine = new MiniSearchEngine(
      MiniSearch.loadJSON(JSON.stringify(state.miniSearch), MINISEARCH_OPTIONS),
    );
    engine.keys = new Set((state.keys ?? []) as string[]);
    return engine;
  }
}

/**
 * In-memory full-text sub-index backed by MiniSearch: a MiniSearch adapter
 * over the shared in-memory block store ({@link MemFullTextIndex}).
 */
export class MiniSearchFullTextIndex extends MemFullTextIndex {
  constructor(info: FullTextIndexInfo) {
    super(info, "MiniSearchFullTextIndex", new MiniSearchEngine());
  }

  protected restoreEngine(state: Record<string, unknown>): MemFullTextEngine {
    return MiniSearchEngine.restore(state);
  }

  /**
   * Serialize to a JSON string (format version 3). Cached: while the index is
   * unchanged, returns the same string without exporting MiniSearch again.
   */
  serialize(): string {
    return this.serializeState();
  }

  /** Deserialize from JSON (format version 3); throws on any other version. */
  static deserialize(info: FullTextIndexInfo, json: string): MiniSearchFullTextIndex {
    const index = new MiniSearchFullTextIndex(info);
    index.restoreState(json);
    return index;
  }
}
