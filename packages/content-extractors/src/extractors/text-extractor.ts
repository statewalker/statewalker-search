import { collectText } from "../collect-bytes.js";
import { DEFAULT_MAX_BYTES, type ExtractorLimits } from "../limits.js";
import type { ContentExtractor } from "../types.js";

/**
 * Identity extractor for plain text -- no conversion needed, just
 * decode bytes to a string. Exists as a distinct entry so `.txt` files
 * route through the same pipeline as every other format.
 */
export function createTextExtractor(limits: ExtractorLimits = {}): ContentExtractor {
  const { maxBytes = DEFAULT_MAX_BYTES } = limits;
  return (content) => collectText(content, { maxBytes });
}

/** Plain-text extractor with the default limits. */
export const textExtractor: ContentExtractor = createTextExtractor();
