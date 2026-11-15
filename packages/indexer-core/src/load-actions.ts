// =============================================================================
// The manifest and load-action rules every kernel shares.
//
// An Index is saved as a manifest: its sub-index specs (`{ type, ...config }`)
// keyed by name. `getIndex(name, options)` turns the saved specs and the caller's
// load actions into one plan per sub-index:
//   - adopt (no action): open with the saved spec and its saved data;
//   - skip (`{ skip: true }`): not opened; its saved spec and data are kept;
//   - reinit (`{ type, ...config }`): the saved data is dropped and the
//     sub-index opens empty with the new spec;
//   - missing: the effective type has no provider. Under `onMissingProvider:
//     "throw"` (the default) the plan fails before anything is touched; under
//     "warn" it is treated like a skip, with a console warning.
// The effective spec is what the manifest holds afterwards. Only storage
// differs between kernels (persistence entries, SQL tables).
// =============================================================================

import type { GetIndexOptions } from "@statewalker/indexer-api";

/** A sub-index spec as saved in the manifest: the `type` discriminator plus its config. */
export type SubIndexSpec = { type: string } & Record<string, unknown>;

/** What happens to one saved sub-index when an Index is opened. */
export type SubIndexPlan =
  | { name: string; action: "adopt"; spec: SubIndexSpec }
  | { name: string; action: "reinit"; saved: SubIndexSpec; spec: SubIndexSpec }
  | { name: string; action: "skip"; saved: SubIndexSpec }
  | { name: string; action: "missing"; saved: SubIndexSpec; spec: SubIndexSpec };

export interface LoadPlan {
  plans: SubIndexPlan[];
  /** The manifest's sub-index specs after opening: reinit replaces, skip and missing keep. */
  effective: Record<string, SubIndexSpec>;
  /** Whether `effective` differs from the saved specs (then the manifest is saved again). */
  changed: boolean;
}

/** The error for a sub-index whose type has no provider. */
export function missingProviderError(
  indexName: string,
  subName: string,
  type: string,
  providerTypes: Iterable<string>,
  verb: "load" | "create" = "load",
): Error {
  return new Error(
    `Cannot ${verb} index "${indexName}": sub-index "${subName}" requires modality "${type}" but only [${[
      ...providerTypes,
    ]
      .map((t) => `"${t}"`)
      .join(", ")}] are registered.`,
  );
}

/**
 * The plan for opening a saved Index. Throws (under "throw") before returning, so a caller that
 * executes the plan never drops data for a sub-index it then fails to open.
 */
export function planLoad(
  indexName: string,
  saved: Record<string, SubIndexSpec>,
  options: GetIndexOptions | undefined,
  providerTypes: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): LoadPlan {
  const onMissing = options?.onMissingProvider ?? "throw";
  const plans: SubIndexPlan[] = [];
  const effective: Record<string, SubIndexSpec> = {};

  for (const [name, savedSpec] of Object.entries(saved)) {
    const action = options?.subIndexes?.[name];
    if (action && "skip" in action) {
      if (action.skip === true) {
        plans.push({ name, action: "skip", saved: savedSpec });
        effective[name] = savedSpec;
        continue;
      }
    }
    const reinit = action !== undefined && !("skip" in action);
    const spec = reinit ? (action as SubIndexSpec) : savedSpec;
    if (!providerTypes.has(spec.type)) {
      if (onMissing === "throw") {
        throw missingProviderError(indexName, name, spec.type, providerTypes.keys());
      }
      plans.push({ name, action: "missing", saved: savedSpec, spec });
      effective[name] = savedSpec;
      continue;
    }
    if (reinit) plans.push({ name, action: "reinit", saved: savedSpec, spec });
    else plans.push({ name, action: "adopt", spec });
    effective[name] = spec;
  }

  // Warn only once the whole plan stands (nothing above throws after a warning).
  for (const plan of plans) {
    if (plan.action !== "missing") continue;
    const g = globalThis as { console?: { warn(...args: unknown[]): void } };
    g.console?.warn(
      `Sub-index "${plan.name}" (type "${plan.spec.type}") on index "${indexName}" has no provider; skipping.`,
    );
  }

  return { plans, effective, changed: JSON.stringify(effective) !== JSON.stringify(saved) };
}

/**
 * Check a `createIndex` spec: every sub-index type needs a provider. An Index with no sub-index
 * is allowed (sub-indexes are bound later, or never).
 */
export function checkCreateSpec(
  indexName: string,
  subIndexes: Record<string, SubIndexSpec> | undefined,
  providerTypes: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): Record<string, SubIndexSpec> {
  const specs = subIndexes ?? {};
  for (const [name, spec] of Object.entries(specs)) {
    if (!providerTypes.has(spec.type)) {
      throw missingProviderError(indexName, name, spec.type, providerTypes.keys(), "create");
    }
  }
  return specs;
}
