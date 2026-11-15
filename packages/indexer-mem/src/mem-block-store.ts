import type { BlockReference, DocumentPath, PathSelector } from "@statewalker/indexer-api";
import { compositeKey, matchesPrefix, toAsyncIterable } from "@statewalker/indexer-core";

/** One engine hit: the store key of a block and the engine's native score. */
export interface RankedKey {
  key: string;
  score: number;
}

/**
 * The engine side of a {@link MemBlockStore}: what one search engine
 * (FlexSearch, MiniSearch, …) supplies. The store owns the blocks and calls
 * the engine only to index, unindex and rank them, addressed by the store's
 * key for a block.
 */
export interface MemBlockEngine<B> {
  /** Index `block` under `key`. A previous version is always removed first. */
  add(key: string, block: B): void;
  /** Unindex the block under `key`. Called only for keys the store holds. */
  remove(key: string): void;
  /**
   * Rank the indexed blocks for one query, best first. `limit` is the depth
   * the caller wants after path filtering; an engine may return more.
   * Keys the store no longer holds are ignored.
   */
  search(query: string, limit: number): RankedKey[];
  /**
   * The engine's own state as JSON-safe fields, framed with the blocks by
   * {@link MemBlockStore.serialize}. Must not use the names `version` or `blocks`.
   */
  exportState(): Record<string, unknown>;
}

/** A fused hit from {@link MemBlockStore.search}. */
export interface MemBlockHit<B> {
  block: B;
  /** The sum of the block's scores over every query it matched. */
  score: number;
}

export interface MemBlockStoreOptions<B> {
  /** Named in errors, e.g. the class of the index that owns the store. */
  label: string;
  engine: MemBlockEngine<B>;
}

/** The persistence format version written by {@link MemBlockStore.serialize}. */
export const MEM_BLOCK_STORE_VERSION = 3;

/**
 * In-memory block store shared by the in-memory search engines.
 *
 * Owns the blocks keyed by `path` + `blockId`, path-prefix selection,
 * enumeration, multi-query score fusion, dirty tracking and the persistence
 * framing; the {@link MemBlockEngine} supplies only add, remove and search.
 *
 * Dirty tracking: the store starts dirty, becomes clean after
 * {@link serialize} or {@link restore}, and becomes dirty again only on a
 * change. Empty batches and deletes that remove nothing are not changes.
 * While clean, `serialize` returns the cached output without asking the
 * engine to export again.
 */
export class MemBlockStore<B extends BlockReference> {
  private readonly label: string;
  private engineRef: MemBlockEngine<B>;
  private blocks = new Map<string, B>();
  private dirty = true;
  private cached?: string;

  constructor(options: MemBlockStoreOptions<B>) {
    this.label = options.label;
    this.engineRef = options.engine;
  }

  /** The engine currently indexing the blocks (replaced by {@link restore}). */
  get engine(): MemBlockEngine<B> {
    return this.engineRef;
  }

  /** `true` when the blocks changed since the last serialize or restore. */
  isDirty(): boolean {
    return this.dirty;
  }

  private markDirty(): void {
    this.dirty = true;
    this.cached = undefined;
  }

  /** The block under `key`, if any. */
  get(key: string): B | undefined {
    return this.blocks.get(key);
  }

  /**
   * Add or replace a batch of blocks. An empty batch changes nothing and
   * leaves the store clean.
   */
  put(batch: readonly B[]): void {
    if (batch.length === 0) return;
    for (const block of batch) {
      const key = compositeKey(block.path, block.blockId);
      if (this.blocks.has(key)) this.engineRef.remove(key);
      this.engineRef.add(key, block);
      this.blocks.set(key, block);
    }
    this.markDirty();
  }

  /**
   * Delete the blocks the selectors match: one block when `blockId` is set,
   * otherwise every block under the path prefix. Returns how many blocks were
   * removed; the store becomes dirty only when that is more than zero.
   */
  async delete(selectors: PathSelector[] | AsyncIterable<PathSelector>): Promise<number> {
    let removed = 0;
    for await (const sel of toAsyncIterable(selectors)) {
      if (sel.blockId !== undefined) {
        if (this.removeKey(compositeKey(sel.path, sel.blockId))) removed += 1;
      } else {
        for (const key of [...this.keys(sel.path)]) {
          if (this.removeKey(key)) removed += 1;
        }
      }
    }
    if (removed > 0) this.markDirty();
    return removed;
  }

  private removeKey(key: string): boolean {
    if (!this.blocks.has(key)) return false;
    this.engineRef.remove(key);
    this.blocks.delete(key);
    return true;
  }

  /** Drop every block, from the store and the engine. */
  clear(): void {
    for (const key of this.blocks.keys()) this.engineRef.remove(key);
    this.blocks.clear();
    this.markDirty();
  }

  private *keys(pathPrefix?: DocumentPath): Iterable<string> {
    for (const [key, block] of this.blocks) {
      if (pathPrefix === undefined || matchesPrefix(block.path, pathPrefix)) yield key;
    }
  }

  /** The blocks under `pathPrefix` (all blocks without one), in insertion order. */
  *select(pathPrefix?: DocumentPath): Iterable<B> {
    for (const key of this.keys(pathPrefix)) {
      const block = this.blocks.get(key);
      if (block) yield block;
    }
  }

  /** How many blocks lie under `pathPrefix` (all blocks without one). */
  count(pathPrefix?: DocumentPath): number {
    if (pathPrefix === undefined) return this.blocks.size;
    let n = 0;
    for (const _ of this.keys(pathPrefix)) n += 1;
    return n;
  }

  /** The distinct document paths under `pathPrefix`, in first-seen order. */
  *paths(pathPrefix?: DocumentPath): Iterable<DocumentPath> {
    const seen = new Set<DocumentPath>();
    for (const block of this.select(pathPrefix)) {
      if (seen.has(block.path)) continue;
      seen.add(block.path);
      yield block.path;
    }
  }

  /**
   * Multi-query search with score fusion. Each query is ranked by the engine,
   * filtered to `pathPrefixes` (when given) and cut to `topK`; the per-block
   * scores are then **summed** across queries, so a block matching more
   * queries ranks higher, and the fused list is cut to `topK` again.
   */
  search(
    queries: readonly string[],
    topK: number,
    pathPrefixes?: DocumentPath[],
  ): MemBlockHit<B>[] {
    const totals = new Map<string, MemBlockHit<B>>();
    const scoped = pathPrefixes !== undefined && pathPrefixes.length > 0;
    for (const query of queries) {
      let taken = 0;
      for (const { key, score } of this.engineRef.search(query, topK)) {
        if (taken >= topK) break;
        const block = this.blocks.get(key);
        if (!block) continue;
        if (scoped && !pathPrefixes.some((p) => matchesPrefix(block.path, p))) continue;
        taken += 1;
        const hit = totals.get(key);
        if (hit) hit.score += score;
        else totals.set(key, { block, score });
      }
    }
    return [...totals.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * Serialize the blocks and the engine state into one JSON document,
   * `{ version: 3, ...engineState, blocks }`. While the store is clean the
   * previous output is returned as is.
   */
  serialize(): string {
    if (!this.dirty && this.cached !== undefined) return this.cached;
    const out = JSON.stringify({
      version: MEM_BLOCK_STORE_VERSION,
      ...this.engineRef.exportState(),
      blocks: [...this.blocks.values()],
    });
    this.cached = out;
    this.dirty = false;
    return out;
  }

  /**
   * Replace the store's content with a document written by {@link serialize}.
   * `restoreEngine` rebuilds the engine from the document's fields. Throws on
   * a document of another version, leaving the store unchanged. The store is
   * clean afterwards and re-serializes to `json` until it changes.
   */
  restore(
    json: string,
    restoreEngine: (state: Record<string, unknown>) => MemBlockEngine<B>,
  ): void {
    const parsed = JSON.parse(json) as { version?: unknown; blocks?: B[] } & Record<
      string,
      unknown
    >;
    if (parsed.version !== MEM_BLOCK_STORE_VERSION) {
      throw new Error(
        `${this.label}: unsupported serialised version ${String(parsed.version)} (expected ${MEM_BLOCK_STORE_VERSION})`,
      );
    }
    const engine = restoreEngine(parsed);
    const blocks = new Map<string, B>();
    for (const block of parsed.blocks ?? []) {
      blocks.set(compositeKey(block.path, block.blockId), block);
    }
    this.engineRef = engine;
    this.blocks = blocks;
    this.cached = json;
    this.dirty = false;
  }
}
