export { createDocxExtractor, docxExtractor } from "./docx-extractor.js";
export { createHtmlExtractor, htmlExtractor } from "./html-extractor.js";
export { createMarkdownExtractor, markdownExtractor } from "./markdown-extractor.js";
export { createPdfExtractor, pdfExtractor } from "./pdf-extractor.js";
export { createTextExtractor, textExtractor } from "./text-extractor.js";
export { createXlsxExtractor, xlsxExtractor } from "./xlsx-extractor.js";

import { ExtractorRegistry } from "../extractor-registry.js";
import type { ZipExtractorLimits } from "../limits.js";
import { createDocxExtractor } from "./docx-extractor.js";
import { createHtmlExtractor } from "./html-extractor.js";
import { createMarkdownExtractor } from "./markdown-extractor.js";
import { createPdfExtractor } from "./pdf-extractor.js";
import { createTextExtractor } from "./text-extractor.js";
import { createXlsxExtractor } from "./xlsx-extractor.js";

/**
 * Provides a batteries-included registry so most consumers can start
 * extracting immediately without manual format registration. Custom
 * registries are still supported for apps that need to override or
 * limit the built-in set. `limits` applies to every registered extractor
 * (`maxUncompressedBytes` only to DOCX, DOCM and XLSX); omitted limits
 * take the defaults.
 */
export function createDefaultRegistry(limits: ZipExtractorLimits = {}): ExtractorRegistry {
  const markdown = createMarkdownExtractor(limits);
  const html = createHtmlExtractor(limits);
  const docx = createDocxExtractor(limits);
  const registry = new ExtractorRegistry();
  registry.registerByPattern("*.md", markdown);
  registry.registerByPattern("*.markdown", markdown);
  registry.registerByPattern("*.txt", createTextExtractor(limits));
  registry.registerByPattern("*.html", html);
  registry.registerByPattern("*.htm", html);
  registry.registerByPattern("*.pdf", createPdfExtractor(limits));
  registry.registerByPattern("*.docx", docx);
  registry.registerByPattern("*.docm", docx);
  registry.registerByPattern("*.xlsx", createXlsxExtractor(limits));
  return registry;
}
