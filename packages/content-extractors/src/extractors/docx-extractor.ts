import mammoth from "mammoth";
import { collectBytes } from "../collect-bytes.js";
import { htmlToMarkdown } from "../html-to-markdown.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
  type ZipExtractorLimits,
} from "../limits.js";
import type { ContentExtractor } from "../types.js";
import { assertZipUncompressedSize } from "../zip-size.js";

/**
 * Unlocks Word document content for text-based pipelines via a two-stage
 * conversion (DOCX -> HTML -> markdown). Supplies both `buffer` and
 * `arrayBuffer` to mammoth so the same code runs in Node.js and browsers
 * without environment detection. The input size and the archive's declared
 * uncompressed size are checked before mammoth inflates it.
 */
export function createDocxExtractor(limits: ZipExtractorLimits = {}): ContentExtractor {
  const { maxBytes = DEFAULT_MAX_BYTES, maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES } =
    limits;
  return async (content) => {
    const bytes = await collectBytes(content, { maxBytes });
    assertZipUncompressedSize(bytes, maxUncompressedBytes);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    // mammoth uses "buffer" in Node.js and "arrayBuffer" in browsers
    const result = await mammoth.convertToHtml({
      buffer: arrayBuffer,
      arrayBuffer,
    } as Parameters<typeof mammoth.convertToHtml>[0]);
    return htmlToMarkdown(result.value);
  };
}

/** DOCX/DOCM extractor with the default limits. */
export const docxExtractor: ContentExtractor = createDocxExtractor();
