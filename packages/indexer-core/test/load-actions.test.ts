import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCreateSpec, planLoad } from "../src/load-actions.js";

// The package is platform-neutral (no DOM or Node types), so `console` is reached through globalThis.
const globalConsole = (globalThis as unknown as { console: { warn(...args: unknown[]): void } })
  .console;
const providers = new Set(["fulltext", "vector"]);
const saved = {
  q: { type: "fulltext", language: "en" },
  v: { type: "vector", dimensionality: 3 },
};

describe("planLoad", () => {
  afterEach(() => vi.restoreAllMocks());

  it("adopts every saved sub-index when no action is given", () => {
    const { plans, effective, changed } = planLoad("i", saved, undefined, providers);
    expect(plans.map((p) => [p.name, p.action])).toEqual([
      ["q", "adopt"],
      ["v", "adopt"],
    ]);
    expect(effective).toEqual(saved);
    expect(changed).toBe(false);
  });

  it("skips, keeping the saved spec, and reinitialises with the new spec", () => {
    const { plans, effective, changed } = planLoad(
      "i",
      saved,
      { subIndexes: { q: { skip: true }, v: { type: "vector", dimensionality: 4 } } },
      providers,
    );
    expect(plans).toEqual([
      { name: "q", action: "skip", saved: saved.q },
      {
        name: "v",
        action: "reinit",
        saved: saved.v,
        spec: { type: "vector", dimensionality: 4 },
      },
    ]);
    expect(effective).toEqual({ q: saved.q, v: { type: "vector", dimensionality: 4 } });
    expect(changed).toBe(true);
  });

  it("throws for a missing provider under 'throw', naming the index, sub-index and type", () => {
    expect(() => planLoad("i", saved, { subIndexes: { v: { type: "nope" } } }, providers)).toThrow(
      'Cannot load index "i": sub-index "v" requires modality "nope"',
    );
    expect(() => planLoad("i", { g: { type: "ngram" } }, undefined, providers)).toThrow(
      /requires modality "ngram" but only \["fulltext", "vector"\] are registered/,
    );
  });

  it("treats a missing provider like a skip under 'warn', and warns", () => {
    const warn = vi.spyOn(globalConsole, "warn").mockImplementation(() => {});
    const { plans, effective, changed } = planLoad(
      "i",
      saved,
      { onMissingProvider: "warn", subIndexes: { v: { type: "nope" } } },
      providers,
    );
    expect(plans[1]).toEqual({
      name: "v",
      action: "missing",
      saved: saved.v,
      spec: { type: "nope" },
    });
    expect(effective).toEqual(saved);
    expect(changed).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'Sub-index "v" (type "nope") on index "i" has no provider; skipping.',
    );
  });

  it("does not warn when the plan throws", () => {
    const warn = vi.spyOn(globalConsole, "warn").mockImplementation(() => {});
    expect(() =>
      planLoad("i", saved, { subIndexes: { q: { type: "a" }, v: { type: "b" } } }, providers),
    ).toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("checkCreateSpec", () => {
  it("accepts an empty or missing spec", () => {
    expect(checkCreateSpec("i", undefined, providers)).toEqual({});
    expect(checkCreateSpec("i", {}, providers)).toEqual({});
  });

  it("throws for a type without a provider", () => {
    expect(() => checkCreateSpec("i", { x: { type: "nope" } }, providers)).toThrow(
      'Cannot create index "i": sub-index "x" requires modality "nope"',
    );
  });
});
