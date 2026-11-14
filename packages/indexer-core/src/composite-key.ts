import type { DocumentPath } from "@statewalker/indexer-api";

/**
 * Joins a (path, blockId) pair into a string key safe to use as a Map key.
 *
 * Length-prefixes the path, so no character in either input can impersonate the
 * path/blockId boundary; the blockId is the remainder after the path.
 */
export function compositeKey(path: DocumentPath, blockId: string): string {
  return `${path.length}:${path}|${blockId}`;
}
