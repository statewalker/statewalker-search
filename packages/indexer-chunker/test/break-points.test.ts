import { describe, expect, it } from "vitest";
import { scanBreakPoints } from "../src/break-points.js";

describe("scanBreakPoints", () => {
  it("returns empty array for empty string", () => {
    expect(scanBreakPoints("")).toEqual([]);
  });

  it("detects H1 with score 100", () => {
    const points = scanBreakPoints("# Hello");
    expect(points).toEqual([{ position: 0, score: 100 }]);
  });

  it("detects H2 with score 90", () => {
    const points = scanBreakPoints("## Hello");
    expect(points).toEqual([{ position: 0, score: 90 }]);
  });

  it("detects H3 with score 80", () => {
    const points = scanBreakPoints("### Hello");
    expect(points).toEqual([{ position: 0, score: 80 }]);
  });

  it("detects H4 with score 70", () => {
    const points = scanBreakPoints("#### Hello");
    expect(points).toEqual([{ position: 0, score: 70 }]);
  });

  it("detects H5 with score 60", () => {
    const points = scanBreakPoints("##### Hello");
    expect(points).toEqual([{ position: 0, score: 60 }]);
  });

  it("detects H6 with score 50", () => {
    const points = scanBreakPoints("###### Hello");
    expect(points).toEqual([{ position: 0, score: 50 }]);
  });

  it("detects blank lines (paragraph breaks) with score 20", () => {
    const text = "Hello\n\nWorld";
    const points = scanBreakPoints(text);
    const blankLine = points.find((p) => p.score === 20);
    expect(blankLine).toBeDefined();
    // The blank line starts at position of the second \n
    expect(blankLine?.position).toBe(6);
  });

  it("detects horizontal rules with score 60", () => {
    for (const rule of ["---", "***", "___"]) {
      const text = `Hello\n${rule}\nWorld`;
      const points = scanBreakPoints(text);
      const hr = points.find((p) => p.score === 60);
      expect(hr).toBeDefined();
      expect(hr?.position).toBe(6);
    }
  });

  it("detects list items with score 5", () => {
    const text = "Hello\n- item one\n* item two\n1. item three";
    const points = scanBreakPoints(text);
    const listItems = points.filter((p) => p.score === 5);
    expect(listItems.length).toBe(3);
  });

  it("detects plain newlines with score 1", () => {
    const text = "line one\nline two";
    const points = scanBreakPoints(text);
    const newlines = points.filter((p) => p.score === 1);
    expect(newlines.length).toBeGreaterThanOrEqual(1);
  });

  it("handles multiple break point types in one document", () => {
    const text = [
      "# Title",
      "",
      "Some text",
      "",
      "## Section",
      "",
      "- item",
      "- item 2",
      "",
      "---",
      "",
      "### Sub",
    ].join("\n");
    const points = scanBreakPoints(text);

    const scores = new Set(points.map((p) => p.score));
    // Should contain heading scores, blank line, list item, hr, newline
    expect(scores.has(100)).toBe(true); // H1
    expect(scores.has(90)).toBe(true); // H2
    expect(scores.has(80)).toBe(true); // H3
    expect(scores.has(60)).toBe(true); // HR
    expect(scores.has(20)).toBe(true); // blank line
    expect(scores.has(5)).toBe(true); // list item
  });

  it("scores the position right after a closing code fence with 80", () => {
    const text = "Hello\n```js\ncode\n```\nWorld";
    const points = scanBreakPoints(text);
    const codeBlocks = points.filter((p) => p.score === 80);
    expect(codeBlocks).toEqual([{ position: text.indexOf("World"), score: 80 }]);
  });

  it("scores the position after a closing tilde fence with 80", () => {
    const text = "Hello\n~~~\ncode\n~~~\nWorld";
    const points = scanBreakPoints(text);
    expect(points.filter((p) => p.score === 80)).toEqual([
      { position: text.indexOf("World"), score: 80 },
    ]);
  });

  it("keeps the higher score when a heading follows a closing fence", () => {
    const text = "```\ncode\n```\n# Title";
    const points = scanBreakPoints(text);
    expect(points.filter((p) => p.position === text.indexOf("# Title"))).toEqual([
      { position: text.indexOf("# Title"), score: 100 },
    ]);
  });

  it("agrees with findCodeFences on which lines are fences", () => {
    // The ``` line inside a ~~~ block is code, not a fence; the 80 goes after
    // the closing ~~~ only.
    const text = "~~~\n```\ncode\n~~~\nafter";
    const points = scanBreakPoints(text);
    expect(points.filter((p) => p.score === 80)).toEqual([
      { position: text.indexOf("after"), score: 80 },
    ]);
  });

  it("adds no fence break point when the closing fence ends the text", () => {
    const points = scanBreakPoints("Hello\n```\ncode\n```");
    expect(points.filter((p) => p.score === 80)).toEqual([]);
  });
});
