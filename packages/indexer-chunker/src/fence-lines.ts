/**
 * Fenced-code-block line detection shared by `findCodeFences` and
 * `scanBreakPoints`, so both agree on which lines open and close a fence.
 *
 * Follows the CommonMark fence rule: an opening fence is a run of at least
 * three backticks or tildes, indented by at most three spaces; a backtick
 * fence's info string may not contain backticks. The block is closed only by
 * a line indented by at most three spaces holding a run of the same character
 * at least as long as the opening run, followed by nothing but whitespace.
 * An unclosed fence runs to the end of the text.
 */

export interface FenceLine {
  /** Position of the first character of the fence line. */
  lineStart: number;
  kind: "open" | "close";
}

const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/;

export function scanFenceLines(text: string): FenceLine[] {
  const result: FenceLine[] = [];
  const lines = text.split("\n");
  let pos = 0;
  let open: { char: string; length: number } | null = null;

  for (const line of lines) {
    if (open === null) {
      const match = OPENING_FENCE.exec(line);
      const run = match?.[1];
      if (run !== undefined) {
        const char = run.charAt(0);
        const info = match?.[2] ?? "";
        if (!(char === "`" && info.includes("`"))) {
          open = { char, length: run.length };
          result.push({ lineStart: pos, kind: "open" });
        }
      }
    } else {
      const run = CLOSING_FENCE.exec(line)?.[1];
      if (run !== undefined && run.charAt(0) === open.char && run.length >= open.length) {
        open = null;
        result.push({ lineStart: pos, kind: "close" });
      }
    }
    pos += line.length + 1;
  }

  return result;
}
