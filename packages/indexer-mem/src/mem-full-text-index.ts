import type {
  BlockReference,
  DocumentPath,
  PathSelector,
  PersistableSearchIndex,
  PersistenceEntry,
} from "@statewalker/indexer-api";
import { readEntryBytes, singleChunk, toBytes } from "@statewalker/indexer-core";
import type {
  FullTextBlock,
  FullTextIndex,
  FullTextIndexInfo,
  FulltextQuery,
  FulltextResult,
} from "@statewalker/indexer-fulltext";
import { type MemBlockEngine, MemBlockStore } from "./mem-block-store.js";

/** The engine of an in-memory full-text index: a {@link MemBlockEngine} over text blocks. */
export type MemFullTextEngine = MemBlockEngine<FullTextBlock>;

/**
 * An in-memory {@link FullTextIndex} over a {@link MemBlockStore}. The store
 * does everything but text indexing; a subclass supplies only the engine
 * adapter (FlexSearch, MiniSearch, …) and how to rebuild it from saved state.
 *
 * Persistence: one entry named `json`, holding the store's framed document.
 */
export abstract class MemFullTextIndex
  implements FullTextIndex, PersistableSearchIndex<FullTextBlock, FulltextQuery, FulltextResult>
{
  protected readonly info: FullTextIndexInfo;
  protected readonly store: MemBlockStore<FullTextBlock>;
  private closed = false;

  /**
   * @param label  named in errors (usually the subclass name)
   * @param engine the engine adapter for a fresh, empty index
   */
  protected constructor(info: FullTextIndexInfo, label: string, engine: MemFullTextEngine) {
    this.info = info;
    this.store = new MemBlockStore<FullTextBlock>({ label, engine });
  }

  /** Rebuild the engine adapter from the fields it exported. */
  protected abstract restoreEngine(state: Record<string, unknown>): MemFullTextEngine;

  /**
   * `true` when the in-memory state has changed since the last serialize or
   * load. Callers (e.g. the persistence layer) may use it to skip writes.
   */
  isDirty(): boolean {
    return this.store.isDirty();
  }

  protected ensureOpen(): void {
    if (this.closed) throw new Error("FullTextIndex is closed");
  }

  /** The framed JSON document; cached while the index is unchanged. */
  protected serializeState(): string {
    return this.store.serialize();
  }

  /** Replace the content with a document from {@link serializeState}. */
  protected restoreState(json: string): void {
    this.store.restore(json, (state) => this.restoreEngine(state));
  }

  async getIndexInfo(): Promise<FullTextIndexInfo> {
    this.ensureOpen();
    return { ...this.info };
  }

  async *search(params: FulltextQuery): AsyncGenerator<FulltextResult> {
    this.ensureOpen();
    const { queries, paths } = params;
    if (!queries || queries.length === 0) return;
    for (const { block, score } of this.store.search(queries, params.topK ?? 100, paths)) {
      yield { path: block.path, blockId: block.blockId, snippet: block.content, score };
    }
  }

  async addDocument(blocks: FullTextBlock[]): Promise<void> {
    this.ensureOpen();
    this.store.put(
      blocks.map((b) => ({
        path: b.path,
        blockId: b.blockId,
        content: b.content,
        metadata: b.metadata,
      })),
    );
  }

  async addDocuments(
    blocks: Iterable<FullTextBlock[]> | AsyncIterable<FullTextBlock[]>,
  ): Promise<void> {
    this.ensureOpen();
    for await (const batch of blocks) {
      await this.addDocument(batch);
    }
  }

  async deleteDocuments(
    pathSelectors: PathSelector[] | AsyncIterable<PathSelector>,
  ): Promise<void> {
    this.ensureOpen();
    await this.store.delete(pathSelectors);
  }

  async getSize(pathPrefix?: DocumentPath): Promise<number> {
    this.ensureOpen();
    return this.store.count(pathPrefix);
  }

  async *getDocumentPaths(pathPrefix?: DocumentPath): AsyncGenerator<DocumentPath> {
    this.ensureOpen();
    yield* this.store.paths(pathPrefix);
  }

  async *getDocumentBlocksRefs(pathPrefix?: DocumentPath): AsyncGenerator<BlockReference> {
    this.ensureOpen();
    for (const block of this.store.select(pathPrefix)) {
      yield { path: block.path, blockId: block.blockId };
    }
  }

  async *getDocumentsBlocks(pathPrefix?: DocumentPath): AsyncGenerator<FullTextBlock> {
    this.ensureOpen();
    for (const block of this.store.select(pathPrefix)) {
      yield { ...block };
    }
  }

  async close(_options?: { force?: boolean }): Promise<void> {
    this.closed = true;
  }

  async flush(): Promise<void> {
    this.ensureOpen();
    // no-op for in-memory
  }

  async deleteIndex(): Promise<void> {
    this.ensureOpen();
    this.store.clear();
    this.closed = true;
  }

  // --- PersistableSearchIndex ------------------------------------------------

  /**
   * Stream the sub-index's state as a single entry named `json`. The composite
   * prefixes it with `${indexName}/${subName}/` before it reaches persistence.
   */
  async *serialise(): AsyncIterable<PersistenceEntry> {
    yield { name: "json", content: singleChunk(toBytes(this.serializeState())) };
  }

  /** Restore the sub-index from a previously produced entry set. */
  async loadFrom(entries: Iterable<PersistenceEntry>): Promise<void> {
    this.ensureOpen();
    for (const e of entries) {
      if (e.name !== "json") continue;
      const bytes = await readEntryBytes(e);
      this.restoreState(new TextDecoder().decode(bytes));
      return;
    }
  }
}
