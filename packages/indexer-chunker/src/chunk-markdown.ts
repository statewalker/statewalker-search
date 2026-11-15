/**
 * Smart markdown chunking with quadratic distance decay.
 *
 * Adapted from QMD (https://github.com/tobi/qmd) by Tobi Lutke.
 * MIT License — Copyright (c) 2024-2026 Tobi Lutke.
 * See: src/store.ts (findBestCutoff, chunkDocument)
 */

import { scanBreakPoints } from "./break-points.js";
import { findCodeFences, isInsideCodeFence } from "./code-fences.js";
import type { BreakPoint, Chunk, ChunkOptions, CodeFence } from "./types.js";

/**
 * Find the best cutoff position near a target character position.
 * Uses a scoring formula that balances break point score with proximity:
 *   finalScore = baseScore * (1 - (distance/windowChars)^2 * decayFactor)
 *
 * Returns the position of the best break point, or -1 if none found.
 */
export function findBestCutoff(
  breakPoints: BreakPoint[],
  fences: CodeFence[],
  target: number,
  windowChars: number,
  decayFactor = 0.5,
): number {
  const windowStart = Math.max(0, target - windowChars);
  const windowEnd = target;

  let bestScore = -Infinity;
  let bestPosition = -1;

  for (const bp of breakPoints) {
    if (bp.position < windowStart || bp.position > windowEnd) continue;
    if (isInsideCodeFence(fences, bp.position)) continue;

    const distance = Math.abs(target - bp.position);
    const normalizedDist = windowChars > 0 ? distance / windowChars : 0;
    const finalScore = bp.score * (1 - normalizedDist * normalizedDist * decayFactor);

    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestPosition = bp.position;
    }
  }

  return bestPosition;
}

/**
 * Throw a RangeError unless `targetChars` is a positive integer and
 * `overlap` an integer with `0 <= overlap < targetChars`.
 */
function validateOptions(targetChars: number, overlap: number): void {
  if (!Number.isInteger(targetChars) || targetChars <= 0) {
    throw new RangeError(`targetChars must be a positive integer, got ${targetChars}`);
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= targetChars) {
    throw new RangeError(
      `overlap must be an integer with 0 <= overlap < targetChars (${targetChars}), got ${overlap}`,
    );
  }
}

/** True when `pos` falls between the two halves of a UTF-16 surrogate pair. */
function splitsSurrogatePair(text: string, pos: number): boolean {
  if (pos <= 0 || pos >= text.length) return false;
  const before = text.charCodeAt(pos - 1);
  const after = text.charCodeAt(pos);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/**
 * Move `pos` off the middle of a surrogate pair: back by one when that keeps
 * it above `min`, otherwise forward by one.
 */
function keepSurrogatePair(text: string, pos: number, min: number): number {
  if (!splitsSurrogatePair(text, pos)) return pos;
  return pos - 1 > min ? pos - 1 : pos + 1;
}

/**
 * Split markdown text into overlapping chunks, preferring structural
 * boundaries (headings, code fences, horizontal rules, paragraph breaks) as
 * split points.
 *
 * Throws a RangeError unless `targetChars` is a positive integer and
 * `overlap` an integer with `0 <= overlap < targetChars`.
 */
export function chunkMarkdown(text: string, options: ChunkOptions): Chunk[] {
  const { targetChars, overlap = 0, windowFraction = 0.5, decayFactor = 0.5 } = options;
  validateOptions(targetChars, overlap);

  if (text.length === 0) return [];

  const breakPoints = scanBreakPoints(text);
  const fences = findCodeFences(text);
  const windowChars = Math.floor(targetChars * windowFraction);

  const chunks: Chunk[] = [];
  let startPos = 0;
  let index = 0;

  while (startPos < text.length) {
    const idealEnd = startPos + targetChars;

    // If remaining text fits in one chunk, take it all
    if (idealEnd >= text.length) {
      chunks.push({
        index,
        content: text.slice(startPos),
        startPos,
        endPos: text.length,
      });
      break;
    }

    // Find best cutoff near the ideal end
    let cutoff = findBestCutoff(breakPoints, fences, idealEnd, windowChars, decayFactor);

    // If no good cutoff found, just cut at idealEnd, but never between the
    // two halves of a surrogate pair. Break points sit at line starts, so
    // only this hard cut can split one.
    if (cutoff === -1 || cutoff <= startPos) {
      cutoff = keepSurrogatePair(text, idealEnd, startPos);
    }

    // Never split inside or on a code-fence boundary. Use the same inclusive
    // semantics as isInsideCodeFence — a cutoff equal to fence.start (the
    // opening fence line) or fence.end (the start of the closing fence line)
    // is "inside" and must be advanced past the closing-fence line. Re-scan
    // after each advance so back-to-back fences don't leave the cutoff in
    // the next one. An unclosed fence, or a closing fence on the last line,
    // moves the cutoff to the end of the text, never past it.
    let advanced = true;
    while (advanced && cutoff < text.length) {
      advanced = false;
      for (const fence of fences) {
        if (cutoff >= fence.start && cutoff <= fence.end) {
          // Advance past the closing fence line (including its trailing newline).
          let next = fence.end;
          while (next < text.length && text[next] !== "\n") next++;
          cutoff = Math.min(next + 1, text.length);
          advanced = true;
          break;
        }
      }
    }

    chunks.push({
      index,
      content: text.slice(startPos, cutoff),
      startPos,
      endPos: cutoff,
    });

    if (cutoff >= text.length) break;

    // Next chunk starts at cutoff minus overlap, always moving forward and
    // never between the two halves of a surrogate pair.
    startPos = keepSurrogatePair(text, Math.max(startPos + 1, cutoff - overlap), startPos);
    index++;
  }

  return chunks;
}
