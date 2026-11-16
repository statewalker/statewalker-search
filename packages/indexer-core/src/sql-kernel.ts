// =============================================================================
// createSqlKernelIndexer — the one Indexer lifecycle for SQL backends.
//
// Owns the manifest (one row per Index), the open-Index cache, the load
// actions (adopt / skip / reinit, `onMissingProvider`) and the delete and close
// rules. What differs between databases sits behind two seams:
//   - `SqlKernelStorage`: where the manifest rows and each Index's shared table
//     live (DuckDB and PGlite: a docs table; SQLite: a block-id table), and how
//     a sub-index's context (its table prefix) is derived;
//   - `SqlModalityProvider`: one per modality type, opening a sub-index over
//     its tables (creating or adopting them) and dropping them without an open
//     instance.
// `createSqlIndexer` (DuckDB, PGlite) and `createSqliteIndexer` are a storage
// plus a provider set each, so a lifecycle fix lands once for every database.
// =============================================================================

import type {
  AnySubIndexBinding,
  CreateIndexParams,
  GetIndexOptions,
  Index,
  Indexer,
  IndexInfo,
  Metadata,
  ScoredHit,
  SearchIndex,
} from "@statewalker/indexer-api";
import { createCompositeIndex } from "./create-composite-index.js";
import { checkCreateSpec, planLoad, type SubIndexSpec } from "./load-actions.js";
import { createSerialiser } from "./run-exclusive.js";

/**
 * A modality backed by SQL tables. Opening is async (tables are created, existing data is
 * adopted), and the provider can drop its tables without an open instance.
 */
export interface SqlModalityProvider<
  Ctx,
  C = Record<string, unknown>,
  I extends SearchIndex<unknown, unknown, ScoredHit> = SearchIndex<unknown, unknown, ScoredHit>,
> {
  readonly type: string;
  open(ctx: Ctx, config: C): Promise<I>;
  drop(ctx: Ctx): Promise<void>;
}

/** One sub-index of an open Index, as the storage sees it. */
export interface SqlKernelSubIndex<Ctx> {
  name: string;
  type: string;
  ctx: Ctx;
}

/** An Index's manifest entry as saved: its sub-index specs, metadata and storage fields. */
export type SavedIndex = Readonly<Record<string, unknown>> & {
  readonly subIndexes: Record<string, SubIndexSpec>;
  /** Sub-index name -> its recorded doc-referencing tables (`SqlKernelStorage.docTables`). */
  readonly docTables?: Readonly<Record<string, string[]>>;
};

/** Where a SQL kernel keeps its manifest and the tables of each Index. */
export interface SqlKernelStorage<Shared, Ctx> {
  /** Every manifest row; called once, when the indexer is created. */
  readManifest(): Promise<Array<{ name: string; config: string }>>;
  /** Insert or replace one manifest row. */
  writeManifest(name: string, config: string): Promise<void>;
  deleteManifest(name: string): Promise<void>;
  /**
   * Open an Index's shared table, creating it if missing. `saved` is the Index's manifest entry
   * (its tables may predate the current naming scheme), or undefined for a new Index.
   */
  openShared(name: string, saved: SavedIndex | undefined): Promise<Shared>;
  /** Drop an Index's shared table (after its sub-indexes' tables). */
  dropShared(name: string, shared: Shared): Promise<void>;
  /**
   * The context of one sub-index (its table prefix, the shared table). `saved` is the Index's
   * manifest entry when the sub-index's saved tables are adopted; undefined for a new or
   * reinitialised sub-index.
   */
  subContext(
    name: string,
    subName: string,
    type: string,
    shared: Shared,
    saved: SavedIndex | undefined,
  ): Promise<Ctx>;
  /** Fields the storage adds to a new Index's manifest entry (e.g. its naming scheme). */
  manifestFields?(): Record<string, unknown>;
  /**
   * Before a new Index's tables are created: refuse it (throw) when its tables would be shared
   * with another Index. `others` is every other Index in the manifest.
   */
  beforeCreate?(
    name: string,
    subIndexes: Record<string, SubIndexSpec>,
    others: ReadonlyMap<string, Record<string, SubIndexSpec>>,
  ): Promise<void>;
  /**
   * The tables of a sub-index at `ctx` that reference the shared table, for a type with a
   * provider. The kernel records them in the Index's manifest entry (`docTables`), so that
   * `afterDelete` can count them while the sub-index's provider is missing.
   */
  docTables?(type: string, ctx: Ctx): string[];
  /**
   * After `deleteDocuments` on an open Index, with every sub-index in its manifest that has a
   * provider, skipped ones included (they keep their rows), and `recordedTables`: the tables
   * recorded (`docTables`) for the manifest's sub-indexes that have no provider, which keep
   * their rows too. Not called when such a sub-index has no record (a manifest entry written
   * before the record existed): its rows cannot be accounted for, so nothing is reclaimed.
   */
  afterDelete?(
    shared: Shared,
    subIndexes: SqlKernelSubIndex<Ctx>[],
    recordedTables: string[],
  ): Promise<void>;
  /** Called by `indexer.close()` once every open Index is closed. */
  close?(): Promise<void>;
}

export interface SqlKernelOptions<Shared, Ctx> {
  storage: SqlKernelStorage<Shared, Ctx>;
  /** One provider per modality type. */
  // biome-ignore lint/suspicious/noExplicitAny: providers take their own config types
  providers: SqlModalityProvider<Ctx, any>[];
}

interface IndexManifest {
  subIndexes: Record<string, SubIndexSpec>;
  /** Index-level metadata from `createIndex` (absent in manifests written before it was saved). */
  metadata?: Metadata;
  /**
   * Sub-index name -> the tables it keeps that reference the shared table
   * (`SqlKernelStorage.docTables`). Written with the entry; kept for a sub-index whose provider
   * is missing. Absent in entries written before it was recorded, and for storages without
   * `docTables`.
   */
  docTables?: Record<string, string[]>;
  /** Storage fields (`SqlKernelStorage.manifestFields`), kept through rewrites. */
  [field: string]: unknown;
}

/** The tables of one open Index: its shared table and the contexts of its sub-indexes. */
interface OpenTables<Shared, Ctx> {
  shared: Shared;
  /** Sub-index name -> context, for every sub-index in the manifest that has a provider. */
  contexts: Map<string, Ctx>;
}

export async function createSqlKernelIndexer<Shared, Ctx>(
  options: SqlKernelOptions<Shared, Ctx>,
): Promise<Indexer> {
  const { storage } = options;
  const providers = new Map(options.providers.map((p) => [p.type, p]));
  const indexes = new Map<string, Index>();
  const manifest = new Map<string, IndexManifest>();
  const runExclusive = createSerialiser();
  let closed = false;

  for (const row of await storage.readManifest()) {
    try {
      manifest.set(row.name, JSON.parse(row.config) as IndexManifest);
    } catch {
      // A malformed row is skipped: the caller can create the Index again.
    }
  }

  function ensureOpen(): void {
    if (closed) throw new Error("Indexer is closed");
  }

  async function writeManifest(name: string, entry: IndexManifest): Promise<void> {
    await storage.writeManifest(name, JSON.stringify(entry));
    manifest.set(name, entry);
  }

  /** The shared table and the contexts of an Index's sub-indexes that have a provider. */
  async function openTables(
    name: string,
    subIndexes: Record<string, SubIndexSpec>,
    saved: SavedIndex | undefined,
  ): Promise<OpenTables<Shared, Ctx>> {
    const shared = await storage.openShared(name, saved);
    const contexts = new Map<string, Ctx>();
    for (const [subName, spec] of Object.entries(subIndexes)) {
      if (!providers.has(spec.type)) continue;
      contexts.set(subName, await storage.subContext(name, subName, spec.type, shared, saved));
    }
    return { shared, contexts };
  }

  /** Drop every table of an Index named in its manifest entry, and the entry itself. */
  async function deleteIndexData(name: string): Promise<void> {
    const saved = manifest.get(name) ?? { subIndexes: {} };
    const subIndexes = saved.subIndexes;
    const { shared, contexts } = await openTables(name, subIndexes, saved);
    for (const [subName, ctx] of contexts) {
      await providers.get((subIndexes[subName] as SubIndexSpec).type)?.drop(ctx);
    }
    await storage.dropShared(name, shared);
    await storage.deleteManifest(name);
    manifest.delete(name);
  }

  /** Evict and close the open instance of an Index, if any. */
  async function closeLive(name: string): Promise<void> {
    const live = indexes.get(name);
    if (!live) return;
    indexes.delete(name);
    try {
      await live.close();
    } catch {
      /* already closed or failing to close: its tables are dropped anyway */
    }
  }

  /**
   * Open an Index from its spec, following the shared load-action rules (`planLoad`). `saved`
   * is the manifest entry, undefined for createIndex. Returns the effective spec to save.
   */
  async function openIndex(
    name: string,
    subIndexes: Record<string, SubIndexSpec>,
    saved: SavedIndex | undefined,
    options: GetIndexOptions | undefined,
    metadata: Metadata | undefined,
  ): Promise<{
    index: Index;
    effective: Record<string, SubIndexSpec>;
    changed: boolean;
    docTables: Record<string, string[]> | undefined;
  }> {
    // Throws for a missing provider before any table is touched.
    const { plans, effective, changed } = planLoad(name, subIndexes, options, providers);
    const tables = await openTables(name, subIndexes, saved);
    const bindings: AnySubIndexBinding[] = [];

    for (const plan of plans) {
      if (plan.action === "skip" || plan.action === "missing") continue; // saved tables kept
      let ctx = tables.contexts.get(plan.name);
      if (plan.action === "reinit") {
        // Drop the saved tables; the new sub-index gets fresh ones.
        if (ctx !== undefined) await providers.get(plan.saved.type)?.drop(ctx);
        ctx = await storage.subContext(name, plan.name, plan.spec.type, tables.shared, undefined);
        tables.contexts.set(plan.name, ctx);
      }
      if (ctx === undefined) {
        // Unreachable: a sub-index whose saved type has a provider has a context.
        throw new Error(`No context for sub-index "${plan.name}" of index "${name}"`);
      }
      const { type, ...config } = plan.spec;
      const provider = providers.get(type);
      if (!provider) throw new Error(`No provider for "${type}"`); // checked by planLoad
      bindings.push({ name: plan.name, type, config, index: await provider.open(ctx, config) });
    }

    // The doc-referencing tables of every sub-index in the effective spec: from its context when
    // its type has a provider, otherwise as recorded before (if at all).
    let docTables: Record<string, string[]> | undefined;
    if (storage.docTables) {
      docTables = {};
      for (const [subName, spec] of Object.entries(effective)) {
        const ctx = tables.contexts.get(subName);
        const recorded =
          ctx !== undefined && providers.has(spec.type)
            ? storage.docTables(spec.type, ctx)
            : saved?.docTables?.[subName];
        if (recorded !== undefined) docTables[subName] = recorded;
      }
    }

    const index: Index = createCompositeIndex({
      name,
      metadata,
      bindings,
      // A closed instance leaves the cache, so getIndex opens a new one.
      onClose: async () => {
        if (indexes.get(name) === index) indexes.delete(name);
      },
      // The bound sub-indexes dropped their tables; drop every sub-index's tables in the
      // manifest (skipped ones too), the shared table and the entry.
      onDeleteIndex: async () => {
        if (indexes.get(name) === index) indexes.delete(name);
        await deleteIndexData(name);
      },
      onAfterDelete: storage.afterDelete
        ? async () => {
            const entry = manifest.get(name);
            const subs: SqlKernelSubIndex<Ctx>[] = [];
            const recordedTables: string[] = [];
            for (const [subName, spec] of Object.entries(entry?.subIndexes ?? {})) {
              const ctx = tables.contexts.get(subName);
              if (ctx !== undefined && providers.has(spec.type)) {
                subs.push({ name: subName, type: spec.type, ctx });
                continue;
              }
              // No provider: its rows still reference doc rows. Count its recorded tables; with
              // no record (an entry from before it was kept), skip the sweep altogether.
              const recorded = entry?.docTables?.[subName];
              if (recorded === undefined) return;
              recordedTables.push(...recorded);
            }
            await storage.afterDelete?.(tables.shared, subs, recordedTables);
          }
        : undefined,
    });
    return { index, effective, changed, docTables };
  }

  return {
    async getIndexNames(): Promise<IndexInfo[]> {
      ensureOpen();
      return [...manifest.entries()].map(([name, entry]) =>
        entry.metadata !== undefined ? { name, metadata: entry.metadata } : { name },
      );
    },

    createIndex(params: CreateIndexParams): Promise<Index> {
      return runExclusive(async () => {
        ensureOpen();
        const { name, overwrite, metadata } = params;
        const subIndexes = checkCreateSpec(name, params.subIndexes, providers);
        if (indexes.has(name) || manifest.has(name)) {
          if (!overwrite) throw new Error(`Index "${name}" already exists`);
          await closeLive(name);
          await deleteIndexData(name);
        }
        if (storage.beforeCreate) {
          const others = new Map<string, Record<string, SubIndexSpec>>();
          for (const [other, entry] of manifest) {
            if (other !== name) others.set(other, entry.subIndexes);
          }
          await storage.beforeCreate(name, subIndexes, others);
        }
        const { index, effective, docTables } = await openIndex(
          name,
          subIndexes,
          undefined,
          undefined,
          metadata,
        );
        await writeManifest(name, {
          ...storage.manifestFields?.(),
          subIndexes: effective,
          ...(docTables !== undefined ? { docTables } : {}),
          ...(metadata !== undefined ? { metadata } : {}),
        });
        indexes.set(name, index);
        return index;
      });
    },

    getIndex(name: string, options?: GetIndexOptions): Promise<Index | null> {
      // Serialised with the other mutating calls, so concurrent first opens open once
      // (a second reinit would otherwise drop tables the first just wrote).
      return runExclusive(async () => {
        ensureOpen();
        const cached = indexes.get(name);
        if (cached) return cached;
        const entry = manifest.get(name);
        if (!entry) return null;
        const { index, effective, changed, docTables } = await openIndex(
          name,
          entry.subIndexes,
          entry,
          options,
          entry.metadata,
        );
        // Load actions that changed the spec (reinit) are saved, and so is a changed record of
        // the doc-referencing tables (an entry written before it was kept gains it here).
        const tablesChanged =
          docTables !== undefined && JSON.stringify(docTables) !== JSON.stringify(entry.docTables);
        if (changed || tablesChanged) {
          await writeManifest(name, {
            ...entry,
            subIndexes: effective,
            ...(docTables !== undefined ? { docTables } : {}),
          });
        }
        indexes.set(name, index);
        return index;
      });
    },

    async hasIndex(name: string): Promise<boolean> {
      ensureOpen();
      return manifest.has(name);
    },

    deleteIndex(name: string): Promise<void> {
      return runExclusive(async () => {
        ensureOpen();
        // An open instance deletes itself (its bindings drop their tables, then every table the
        // manifest names, skipped sub-indexes' too); otherwise drop the saved tables directly.
        const live = indexes.get(name);
        if (live) await live.deleteIndex();
        else if (manifest.has(name)) await deleteIndexData(name);
      });
    },

    flush(): Promise<void> {
      return runExclusive(async () => {
        ensureOpen();
        for (const index of indexes.values()) await index.flush();
      });
    },

    close(): Promise<void> {
      return runExclusive(async () => {
        if (closed) return;
        closed = true;
        for (const index of [...indexes.values()]) {
          try {
            await index.close();
          } catch {
            /* closing the others matters more */
          }
        }
        indexes.clear();
        manifest.clear();
        await storage.close?.();
      });
    },
  } satisfies Indexer;
}
