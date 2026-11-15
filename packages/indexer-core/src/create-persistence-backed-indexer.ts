import type {
  AnySubIndexBinding,
  CreateIndexParams,
  GetIndexOptions,
  Index,
  Indexer,
  IndexerPersistence,
  IndexInfo,
  Metadata,
  ModalityProvider,
  PersistenceEntry,
  ScoredHit,
  SearchIndex,
} from "@statewalker/indexer-api";
import { isPersistable } from "@statewalker/indexer-api";
import { createCompositeIndex } from "./create-composite-index.js";
import { checkCreateSpec, planLoad } from "./load-actions.js";
import { readEntryBytes, singleChunk, toBytes } from "./persistence-bytes.js";
import { createSerialiser } from "./run-exclusive.js";

/**
 * Options for {@link createPersistenceBackedIndexer}.
 *
 * `providers` declares the modalities this Indexer can construct; the factory
 * looks each one up at `createIndex` / `getIndex` time by the `type`
 * discriminator in `params.subIndexes` or the saved manifest.
 *
 * `persistence` is the optional storage port. When absent, the Indexer runs in
 * pure in-memory mode.
 */
export interface PersistenceBackedIndexerOptions {
  providers: ModalityProvider<unknown, SearchIndex<unknown, unknown, ScoredHit>>[];
  persistence?: IndexerPersistence;
}

/** Saved per-Index manifest payload. */
interface IndexManifest {
  name: string;
  subIndexes: Record<string, { type: string } & Record<string, unknown>>;
  /** Index-level metadata from `createIndex` (absent in manifests written before it was saved). */
  metadata?: Metadata;
}

const TOP_MANIFEST = "__manifest__";
const MANIFEST_SUFFIX = "__manifest__";

/** One name segment of an entry name: URI-encoded, so it never contains a `/`. */
function seg(name: string): string {
  return encodeURIComponent(name);
}

/** Entry name of an Index's manifest. */
function manifestEntryName(indexName: string): string {
  return `${seg(indexName)}/${MANIFEST_SUFFIX}`;
}

/** Entry-name prefix of a sub-index's entries (`<prefix><suffix>`). */
function subEntryPrefix(indexName: string, subName: string): string {
  return `${seg(indexName)}/${seg(subName)}/`;
}

/**
 * Generic persistence-backed `Indexer` factory. Modality-agnostic: takes a list
 * of `ModalityProvider`s and routes by the `type` discriminator. Sub-index
 * serialisation flows through each sub-index's own `PersistableSearchIndex`
 * implementation; non-persistable modalities are simply skipped at save.
 *
 * Wire format under one `IndexerPersistence` store:
 * - `__manifest__` — JSON array of all known index names
 * - `${enc(indexName)}/__manifest__` — JSON `IndexManifest` (mirrors `CreateIndexParams.subIndexes`)
 * - `${enc(indexName)}/${enc(subIndexName)}/<entry>` — each persistable sub-index's `serialise()`
 *   output, prefixed to keep entries namespaced across sub-indexes and Indexes
 *
 * `enc` is `encodeURIComponent`, so a `/` in a name cannot be mistaken for a separator. It leaves
 * `[A-Za-z0-9-_.!~*'()]` unchanged, so names made of those keep the entry names of earlier
 * versions, which wrote names unencoded. For other names, loading falls back to the unencoded
 * entry names when there is no encoded manifest naming the Index; the next save writes the
 * encoded ones.
 */
export function createPersistenceBackedIndexer(opts: PersistenceBackedIndexerOptions): Indexer {
  const providersByType = new Map<
    string,
    ModalityProvider<unknown, SearchIndex<unknown, unknown, ScoredHit>>
  >();
  for (const p of opts.providers) providersByType.set(p.type, p);

  const persistence = opts.persistence;
  const runExclusive = createSerialiser();

  // In-memory caches.
  const liveIndexes = new Map<string, Index>(); // currently-open indexes
  const knownNames = new Set<string>(); // names from manifest (live or not)
  // Pre-loaded entries grouped per Index, parsed on construction or save.
  // Map<indexName, Map<subIndexName, Map<entrySuffix, Uint8Array>>>
  // Manifest lives separately to keep lookup straightforward.
  const savedManifests = new Map<string, IndexManifest>();
  // Sub-index entry pools cached as raw bytes so the same entry can be replayed
  // across multiple saves: Map<indexName, Map<subIndexName, Map<suffix, bytes>>>
  const savedSubEntries = new Map<string, Map<string, Map<string, Uint8Array>>>();
  // Sub-index names skipped at load via `{skip: true}`. Per D9, their saved
  // manifest entries + bytes must survive the next save unchanged.
  const skippedSubsPerIndex = new Map<string, Set<string>>();

  let initialized = false;
  let initPromise: Promise<void> | null = null;
  let closed = false;

  function ensureOpen(): void {
    if (closed) throw new Error("Indexer is closed");
  }

  function findProvider(
    type: string,
  ): ModalityProvider<unknown, SearchIndex<unknown, unknown, ScoredHit>> | undefined {
    return providersByType.get(type);
  }

  async function loadFromPersistence(): Promise<void> {
    if (!persistence || initialized) return;
    const entryBytes = new Map<string, Uint8Array>();
    for await (const entry of persistence.load()) {
      entryBytes.set(entry.name, await readEntryBytes(entry));
    }
    const decoder = new TextDecoder();

    const topBytes = entryBytes.get(TOP_MANIFEST);
    if (topBytes) {
      const names = JSON.parse(decoder.decode(topBytes)) as string[];
      for (const name of names) knownNames.add(name);
    }

    // Sub-index entries by their `<index>/<sub>/` prefix. Encoded segments hold no `/`, so the
    // prefix ends at the second `/`.
    const byPrefix = new Map<string, Map<string, Uint8Array>>();
    for (const [entryName, bytes] of entryBytes) {
      const firstSlash = entryName.indexOf("/");
      if (firstSlash < 0) continue;
      const secondSlash = entryName.indexOf("/", firstSlash + 1);
      if (secondSlash < 0) continue;
      const prefix = entryName.slice(0, secondSlash + 1);
      let group = byPrefix.get(prefix);
      if (!group) {
        group = new Map();
        byPrefix.set(prefix, group);
      }
      group.set(entryName.slice(secondSlash + 1), bytes);
    }

    // Entries written unencoded by earlier versions; a `/` in a name makes the prefix ambiguous,
    // so they are matched by the full expected prefix.
    function legacySubEntries(prefix: string): Map<string, Uint8Array> {
      const found = new Map<string, Uint8Array>();
      for (const [entryName, bytes] of entryBytes) {
        if (entryName.startsWith(prefix)) found.set(entryName.slice(prefix.length), bytes);
      }
      return found;
    }

    function readManifest(entryName: string): IndexManifest | undefined {
      const bytes = entryBytes.get(entryName);
      return bytes ? (JSON.parse(decoder.decode(bytes)) as IndexManifest) : undefined;
    }

    for (const name of knownNames) {
      // The encoded entry is this Index's only if its manifest names it: in a store written
      // by an earlier version, `a%20b/__manifest__` is the unencoded entry of an Index named
      // "a%20b", not the encoded one of "a b".
      const encoded = readManifest(manifestEntryName(name));
      const useEncoded = encoded !== undefined && encoded.name === name;
      const manifest = useEncoded ? encoded : readManifest(`${name}/${MANIFEST_SUFFIX}`);
      if (!manifest) continue;
      savedManifests.set(name, manifest);

      const perIndex = new Map<string, Map<string, Uint8Array>>();
      for (const subName of Object.keys(manifest.subIndexes)) {
        let entries: Map<string, Uint8Array> | undefined;
        if (useEncoded) entries = byPrefix.get(subEntryPrefix(name, subName));
        else {
          const legacy = legacySubEntries(`${name}/${subName}/`);
          if (legacy.size > 0) entries = legacy;
        }
        if (entries) perIndex.set(subName, entries);
      }
      if (perIndex.size > 0) savedSubEntries.set(name, perIndex);
    }

    initialized = true;
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    if (!initPromise) {
      initPromise = loadFromPersistence().catch((err) => {
        initPromise = null;
        throw err;
      });
    }
    await initPromise;
  }

  function emitEntry(entryName: string, bytes: Uint8Array): PersistenceEntry {
    return { name: entryName, content: singleChunk(bytes) };
  }

  /**
   * The manifest and the persistable sub-indexes' entries of an open Index. Sub-indexes skipped
   * at open (per D9) keep their saved manifest entry and bytes verbatim.
   */
  async function captureIndex(
    indexName: string,
    live: Index,
  ): Promise<{ manifest: IndexManifest; subs: Map<string, Map<string, Uint8Array>> }> {
    const skipped = skippedSubsPerIndex.get(indexName);
    const savedM = savedManifests.get(indexName);
    const savedSubs = savedSubEntries.get(indexName);

    // Compose manifest from live bindings + preserved skipped configs.
    const manifest: IndexManifest = {
      name: indexName,
      subIndexes: {},
      ...(live.metadata !== undefined ? { metadata: live.metadata } : {}),
    };
    const subs = new Map<string, Map<string, Uint8Array>>();
    for (const b of live.getBindings()) {
      manifest.subIndexes[b.name] = { type: b.type, ...(b.config as Record<string, unknown>) };
      // Persistable bindings stream their entries, saved under `subEntryPrefix(...)<suffix>`.
      if (!isPersistable(b.index)) continue;
      const entries = new Map<string, Uint8Array>();
      for await (const sub of b.index.serialise()) entries.set(sub.name, await readEntryBytes(sub));
      subs.set(b.name, entries);
    }
    for (const subName of skipped ?? []) {
      const spec = savedM?.subIndexes[subName];
      if (spec) manifest.subIndexes[subName] = spec;
      const entries = savedSubs?.get(subName);
      if (entries) subs.set(subName, entries);
    }
    return { manifest, subs };
  }

  async function saveToPersistence(): Promise<void> {
    if (!persistence) return;
    const self = {
      async *generate(): AsyncIterable<PersistenceEntry> {
        const allNames = new Set<string>([...knownNames]);
        for (const n of liveIndexes.keys()) allNames.add(n);
        yield emitEntry(TOP_MANIFEST, toBytes(JSON.stringify([...allNames])));

        for (const indexName of allNames) {
          const live = liveIndexes.get(indexName);
          if (live) {
            const { manifest, subs } = await captureIndex(indexName, live);
            yield emitEntry(manifestEntryName(indexName), toBytes(JSON.stringify(manifest)));
            for (const [subName, entries] of subs) {
              const prefix = subEntryPrefix(indexName, subName);
              for (const [suffix, bytes] of entries) yield emitEntry(`${prefix}${suffix}`, bytes);
            }
          } else {
            // Index not open in this session — preserve saved bytes.
            const savedM = savedManifests.get(indexName);
            if (savedM)
              yield emitEntry(manifestEntryName(indexName), toBytes(JSON.stringify(savedM)));
            const perIndex = savedSubEntries.get(indexName);
            if (perIndex) {
              for (const [subName, entries] of perIndex) {
                const prefix = subEntryPrefix(indexName, subName);
                for (const [suffix, bytes] of entries) yield emitEntry(`${prefix}${suffix}`, bytes);
              }
            }
          }
        }
      },
    };

    await persistence.save(self.generate());
  }

  async function buildIndex(name: string, options?: GetIndexOptions): Promise<Index> {
    const manifest = savedManifests.get(name);
    if (!manifest) {
      // No saved manifest — Index isn't yet persisted; nothing to load from.
      return newComposite(name, []);
    }

    // The shared load-action rules; throws for a missing provider before anything is built.
    const { plans } = planLoad(name, manifest.subIndexes, options, providersByType);

    const bindings: AnySubIndexBinding[] = [];
    const skipped = new Set<string>();
    const perIndex = savedSubEntries.get(name);
    for (const plan of plans) {
      if (plan.action === "skip" || plan.action === "missing") {
        skipped.add(plan.name); // its saved spec and bytes survive the next save (D9)
        continue;
      }
      const { type: effType, ...effConfig } = plan.spec;
      const provider = findProvider(effType);
      if (!provider) throw new Error(`No provider for "${effType}"`); // checked by planLoad
      const subIndex = provider.create(effConfig);
      // Adopt loads the saved bytes; reinit starts empty (its old bytes go at the next save).
      if (plan.action === "adopt" && isPersistable(subIndex)) {
        const bytesBySuffix = perIndex?.get(plan.name);
        if (bytesBySuffix && bytesBySuffix.size > 0) {
          const entries: PersistenceEntry[] = [];
          for (const [suffix, bytes] of bytesBySuffix) {
            entries.push({ name: suffix, content: singleChunk(bytes) });
          }
          await subIndex.loadFrom(entries);
        }
      }
      bindings.push({ name: plan.name, type: effType, config: effConfig, index: subIndex });
    }

    if (skipped.size > 0) skippedSubsPerIndex.set(name, skipped);
    else skippedSubsPerIndex.delete(name);
    return newComposite(name, bindings, manifest.metadata);
  }

  /**
   * Keep the state of an Index that is being closed, so `getIndex` can rebuild it and the
   * next save still writes it, then drop it from the open set.
   */
  async function parkIndex(name: string, index: Index): Promise<void> {
    const { manifest, subs } = await captureIndex(name, index);
    savedManifests.set(name, manifest);
    savedSubEntries.set(name, subs);
    skippedSubsPerIndex.delete(name);
    liveIndexes.delete(name);
  }

  function forgetIndex(name: string): void {
    liveIndexes.delete(name);
    savedManifests.delete(name);
    savedSubEntries.delete(name);
    skippedSubsPerIndex.delete(name);
    knownNames.delete(name);
  }

  function newComposite(name: string, bindings: AnySubIndexBinding[], metadata?: Metadata): Index {
    const index: Index = createCompositeIndex({
      name,
      metadata,
      bindings,
      // A closed instance leaves the open set with its state parked, so getIndex reopens it.
      // Skipped when the instance is no longer the open one (the indexer is closing it, or
      // createIndex/deleteIndex already replaced or removed it).
      onClose: async () => {
        if (closed || liveIndexes.get(name) !== index) return;
        await runExclusive(async () => {
          if (!closed && liveIndexes.get(name) === index) await parkIndex(name, index);
        });
      },
      // index.deleteIndex() removes the Index from the indexer too.
      onDeleteIndex: async () => {
        if (liveIndexes.get(name) === index) forgetIndex(name);
      },
    });
    return index;
  }

  return {
    async getIndexNames(): Promise<IndexInfo[]> {
      ensureOpen();
      await ensureInitialized();
      const names = new Set([...knownNames, ...liveIndexes.keys()]);
      return [...names].map((name) => {
        const metadata = liveIndexes.get(name)?.metadata ?? savedManifests.get(name)?.metadata;
        return metadata !== undefined ? { name, metadata } : { name };
      });
    },

    createIndex(params: CreateIndexParams): Promise<Index> {
      return runExclusive(async () => {
        ensureOpen();
        await ensureInitialized();
        const { name, overwrite, metadata } = params;
        const subIndexes = checkCreateSpec(name, params.subIndexes, providersByType);

        if (knownNames.has(name) || liveIndexes.has(name)) {
          if (!overwrite) throw new Error(`Index "${name}" already exists`);
          const live = liveIndexes.get(name);
          forgetIndex(name);
          if (live) await live.close();
        }

        const bindings: AnySubIndexBinding[] = [];
        for (const [subName, spec] of Object.entries(subIndexes)) {
          const { type, ...config } = spec;
          const provider = findProvider(type);
          if (!provider) throw new Error(`No provider for "${type}"`); // checked above
          const subIndex = provider.create(config);
          bindings.push({ name: subName, type, config, index: subIndex });
        }

        const index = newComposite(name, bindings, metadata);
        liveIndexes.set(name, index);
        knownNames.add(name);
        return index;
      });
    },

    getIndex(name: string, options?: GetIndexOptions): Promise<Index | null> {
      // Serialised with the other mutating calls, so concurrent first opens build one instance.
      return runExclusive(async () => {
        ensureOpen();
        await ensureInitialized();
        if (!knownNames.has(name) && !liveIndexes.has(name)) return null;
        const live = liveIndexes.get(name);
        if (live) return live;
        const built = await buildIndex(name, options);
        liveIndexes.set(name, built);
        return built;
      });
    },

    async hasIndex(name: string): Promise<boolean> {
      ensureOpen();
      await ensureInitialized();
      return knownNames.has(name) || liveIndexes.has(name);
    },

    deleteIndex(name: string): Promise<void> {
      return runExclusive(async () => {
        ensureOpen();
        await ensureInitialized();
        // An open instance deletes itself (its sub-indexes, then its state here, through
        // onDeleteIndex); otherwise its saved state is dropped directly.
        const live = liveIndexes.get(name);
        if (live) await live.deleteIndex();
        forgetIndex(name);
      });
    },

    flush(): Promise<void> {
      return runExclusive(async () => {
        ensureOpen();
        await ensureInitialized();
        await saveToPersistence();
      });
    },

    close(): Promise<void> {
      return runExclusive(async () => {
        if (closed) return;
        await ensureInitialized();
        await saveToPersistence();
        closed = true;
        for (const index of [...liveIndexes.values()]) await index.close();
        liveIndexes.clear();
      });
    },
  };
}
