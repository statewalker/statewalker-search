import { describe, expect, it } from "vitest";
import { findCodeFences, isInsideCodeFence } from "../src/code-fences.js";

describe("findCodeFences", () => {
  it("finds a single fence pair", () => {
    const text = "Hello\n```js\ncode here\n```\nWorld";
    const fences = findCodeFences(text);
    expect(fences.length).toBe(1);
    expect(fences[0]?.start).toBe(6); // position of opening ```
    expect(fences[0]?.end).toBe(22); // position of closing ```
  });

  it("finds multiple fence pairs", () => {
    const text = "A\n```\nblock1\n```\nB\n```\nblock2\n```\nC";
    const fences = findCodeFences(text);
    expect(fences.length).toBe(2);
  });

  it("handles unclosed fence extending to end", () => {
    const text = "Hello\n```\ncode without close";
    const fences = findCodeFences(text);
    expect(fences.length).toBe(1);
    expect(fences[0]?.start).toBe(6);
    expect(fences[0]?.end).toBe(text.length);
  });

  it("returns empty array when no fences", () => {
    const fences = findCodeFences("Just plain text\nno fences here");
    expect(fences).toEqual([]);
  });
});

describe("isInsideCodeFence", () => {
  it("returns true for position inside a fence", () => {
    const fences = [{ start: 10, end: 30 }];
    expect(isInsideCodeFence(fences, 15)).toBe(true);
    expect(isInsideCodeFence(fences, 10)).toBe(true);
    expect(isInsideCodeFence(fences, 30)).toBe(true);
  });

  it("returns false for position outside a fence", () => {
    const fences = [{ start: 10, end: 30 }];
    expect(isInsideCodeFence(fences, 5)).toBe(false);
    expect(isInsideCodeFence(fences, 35)).toBe(false);
  });

  it("returns false for empty fences array", () => {
    expect(isInsideCodeFence([], 10)).toBe(false);
  });
});

describe("findCodeFences: CommonMark fence rule", () => {
  it("recognises tilde fences", () => {
    const text = "A\n~~~\ncode\n~~~\nB";
    expect(findCodeFences(text)).toEqual([{ start: 2, end: 11 }]);
  });

  it("recognises tilde fences with an info string", () => {
    const text = "A\n~~~ts\ncode\n~~~\nB";
    expect(findCodeFences(text)).toEqual([{ start: 2, end: 13 }]);
  });

  it("does not close a tilde fence with backticks, nor a backtick fence with tildes", () => {
    const tilde = "~~~\n```\ncode\n```\n~~~\nafter";
    expect(findCodeFences(tilde)).toEqual([{ start: 0, end: 17 }]);
    const backtick = "```\n~~~\ncode\n~~~\n```\nafter";
    expect(findCodeFences(backtick)).toEqual([{ start: 0, end: 17 }]);
  });

  it("closes a fence only with a fence at least as long as the opening one", () => {
    const text = "````md\n```js\nx\n```\n````\nafter";
    expect(findCodeFences(text)).toEqual([{ start: 0, end: 19 }]);
  });

  it("accepts a longer closing fence", () => {
    const text = "```\nx\n`````\nafter";
    expect(findCodeFences(text)).toEqual([{ start: 0, end: 6 }]);
  });

  it("does not treat a closing line with an info string as a closing fence", () => {
    const text = "```\nx\n``` js\ny\n```\nafter";
    expect(findCodeFences(text)).toEqual([{ start: 0, end: 15 }]);
  });

  it("does not open a backtick fence whose info string contains a backtick", () => {
    expect(findCodeFences("``` a`b\ncode\nmore")).toEqual([]);
  });

  it("allows backticks in a tilde fence's info string", () => {
    const text = "~~~ a`b\ncode\n~~~";
    expect(findCodeFences(text)).toEqual([{ start: 0, end: 13 }]);
  });

  it("allows up to three spaces of indentation, not four", () => {
    expect(findCodeFences("   ```\ncode\n   ```")).toEqual([{ start: 0, end: 12 }]);
    expect(findCodeFences("    ```\ncode\n    ```")).toEqual([]);
  });

  it("ignores runs shorter than three characters", () => {
    expect(findCodeFences("``\ncode\n~~\n")).toEqual([]);
  });
});
