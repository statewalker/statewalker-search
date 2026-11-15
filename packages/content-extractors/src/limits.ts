/** Default largest input an extractor reads: 100 MiB. */
export const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

/** Default largest total uncompressed size of a DOCX/XLSX archive: 500 MiB. */
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;

/** Limits every built-in extractor accepts. Pass `Infinity` to turn a limit off. */
export interface ExtractorLimits {
  /** Largest input read, in bytes. Default {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
}

/** Limits of the ZIP-based extractors (DOCX, DOCM, XLSX). */
export interface ZipExtractorLimits extends ExtractorLimits {
  /**
   * Largest sum of the uncompressed entry sizes declared in the archive's central directory,
   * checked before the archive is inflated. Default {@link DEFAULT_MAX_UNCOMPRESSED_BYTES}.
   */
  maxUncompressedBytes?: number;
}
