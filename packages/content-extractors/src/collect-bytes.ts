/** Options for {@link collectBytes} and {@link collectText}. */
export interface CollectOptions {
  /**
   * Largest input accepted, in bytes. Reading stops and an error is thrown as soon as the total
   * exceeds it, so an oversized or endless stream is never held in memory. No limit when omitted.
   */
  maxBytes?: number;
}

/**
 * Bridges the streaming world (chunked iterables from fetch, file reads,
 * etc.) with libraries that require a single contiguous buffer (pdfjs-dist,
 * mammoth). Returns the original chunk when only one arrives, avoiding
 * an extra copy in the common single-read case.
 */
export async function collectBytes(
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: CollectOptions = {},
): Promise<Uint8Array> {
  const { maxBytes = Number.POSITIVE_INFINITY } = options;
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for await (const chunk of content) {
    totalLength += chunk.length;
    if (totalLength > maxBytes) {
      throw new Error(`Input exceeds the limit of ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  const first = chunks[0];
  if (chunks.length === 1 && first) {
    return first;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Shorthand for text-based extractors (plain text, markdown, HTML) that
 * need the full content as a string. Avoids duplicating the
 * collect-then-decode pattern across every text extractor.
 */
export async function collectText(
  content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options: CollectOptions = {},
): Promise<string> {
  const bytes = await collectBytes(content, options);
  return new TextDecoder().decode(bytes);
}
