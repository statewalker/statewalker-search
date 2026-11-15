import { collectText } from "../collect-bytes.js";
import { DEFAULT_MAX_BYTES, type ExtractorLimits } from "../limits.js";
import type { ContentExtractor } from "../types.js";

/**
 * Passthrough extractor for markdown files. Functionally identical to
 * `textExtractor` but registered under its own extension patterns so
 * the registry can distinguish `.md` from `.txt` -- allowing future
 * markdown-specific processing without breaking existing registrations.
 */
export function createMarkdownExtractor(limits: ExtractorLimits = {}): ContentExtractor {
  const { maxBytes = DEFAULT_MAX_BYTES } = limits;
  return (content) => collectText(content, { maxBytes });
}

/** Markdown extractor with the default limits. */
export const markdownExtractor: ContentExtractor = createMarkdownExtractor();
