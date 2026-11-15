/**
 * Markdown break-point detection with weighted scoring.
 *
 * Adapted from QMD (https://github.com/tobi/qmd) by Tobi Lutke.
 * MIT License — Copyright (c) 2024-2026 Tobi Lutke.
 * See: src/store.ts (scanBreakPoints)
 */

import { scanFenceLines } from "./fence-lines.js";
import type { BreakPoint } from "./types.js";

const HEADING_PATTERNS: Array<{ prefix: string; score: number }> = [
  { prefix: "###### ", score: 50 },
  { prefix: "##### ", score: 60 },
  { prefix: "#### ", score: 70 },
  { prefix: "### ", score: 80 },
  { prefix: "## ", score: 90 },
  { prefix: "# ", score: 100 },
];

const HR_REGEX = /^(---|___|\*\*\*)$/;
const LIST_REGEX = /^(\d+\.\s|[-*]\s)/;
const AFTER_FENCE_SCORE = 80;

/**
 * Scan markdown text for structural break points, returning their
 * character positions and scores.
 *
 * Fence lines themselves get no break point (a cut there is inside the
 * block); the start of the line right after a closing fence scores at
 * least 80.
 */
export function scanBreakPoints(text: string): BreakPoint[] {
  if (text.length === 0) return [];

  const fenceLines = new Map<number, "open" | "close">();
  for (const { lineStart, kind } of scanFenceLines(text)) fenceLines.set(lineStart, kind);

  const points: BreakPoint[] = [];
  const lines = text.split("\n");
  let pos = 0;
  let afterClosingFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const fence = fenceLines.get(pos);
    let score = fence === undefined ? lineScore(line, i) : undefined;
    if (afterClosingFence) score = Math.max(score ?? 0, AFTER_FENCE_SCORE);
    if (score !== undefined) points.push({ position: pos, score });
    afterClosingFence = fence === "close";
    pos += line.length + 1; // +1 for the \n
  }

  return points;
}

/** Score of the break point at the start of a non-fence line, if any. */
function lineScore(line: string, index: number): number | undefined {
  const trimmed = line.trim();

  // Blank line (paragraph break): the \n that starts it.
  if (trimmed === "") return index > 0 ? 20 : undefined;

  // Horizontal rule
  if (HR_REGEX.test(trimmed)) return 60;

  // Headings (longest prefix first to avoid false matches)
  for (const { prefix, score } of HEADING_PATTERNS) {
    if (line.startsWith(prefix)) return score;
  }

  // List items
  if (LIST_REGEX.test(trimmed)) return 5;

  // Plain newline (the newline that ended the previous line), recorded at
  // the start of this line
  return index > 0 ? 1 : undefined;
}
