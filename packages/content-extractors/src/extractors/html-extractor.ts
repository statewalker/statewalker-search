import { collectText } from "../collect-bytes.js";
import { htmlToMarkdown } from "../html-to-markdown.js";
import { DEFAULT_MAX_BYTES, type ExtractorLimits } from "../limits.js";
import type { ContentExtractor } from "../types.js";

/**
 * Converts HTML files to markdown so the pipeline outputs a uniform
 * text format. Delegates to `htmlToMarkdown` for the actual conversion,
 * keeping this extractor focused on the bytes-to-string bridging step.
 */
export function createHtmlExtractor(limits: ExtractorLimits = {}): ContentExtractor {
  const { maxBytes = DEFAULT_MAX_BYTES } = limits;
  return async (content) => htmlToMarkdown(await collectText(content, { maxBytes }));
}

/** HTML extractor with the default limits. */
export const htmlExtractor: ContentExtractor = createHtmlExtractor();
