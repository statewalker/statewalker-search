import { scanFenceLines } from "./fence-lines.js";
import type { CodeFence } from "./types.js";

/**
 * Find all fenced code blocks (``` or ~~~, CommonMark fence rule) in the text.
 * Returns pairs of {start, end} character positions: `start` is the start of
 * the opening fence line, `end` the start of the closing fence line.
 * An unclosed fence extends to the end of the text.
 */
export function findCodeFences(text: string): CodeFence[] {
  const fences: CodeFence[] = [];
  let openStart: number | null = null;

  for (const { lineStart, kind } of scanFenceLines(text)) {
    if (kind === "open") {
      openStart = lineStart;
    } else if (openStart !== null) {
      fences.push({ start: openStart, end: lineStart });
      openStart = null;
    }
  }

  // Unclosed fence extends to end
  if (openStart !== null) {
    fences.push({ start: openStart, end: text.length });
  }

  return fences;
}

/**
 * Check whether a character position falls inside any code fence region.
 */
export function isInsideCodeFence(fences: CodeFence[], position: number): boolean {
  for (const fence of fences) {
    if (position >= fence.start && position <= fence.end) {
      return true;
    }
  }
  return false;
}
