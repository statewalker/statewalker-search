import { describe, expect, it } from "vitest";
import { collectBytes, collectText } from "../src/collect-bytes.js";

const enc = new TextEncoder();

async function* stream(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const p of parts) yield enc.encode(p);
}

describe("collectBytes", () => {
  it("joins chunks", async () => {
    const bytes = await collectBytes(stream("ab", "cd"));
    expect(new TextDecoder().decode(bytes)).toBe("abcd");
  });

  it("accepts input up to maxBytes", async () => {
    const bytes = await collectBytes(stream("ab", "cd"), { maxBytes: 4 });
    expect(bytes.length).toBe(4);
  });

  it("throws when the input exceeds maxBytes", async () => {
    await expect(collectBytes(stream("ab", "cd", "e"), { maxBytes: 4 })).rejects.toThrow(
      /exceeds the limit of 4 bytes/,
    );
  });

  it("stops reading once the limit is exceeded", async () => {
    let pulled = 0;
    async function* endless(): AsyncIterable<Uint8Array> {
      while (true) {
        pulled++;
        yield new Uint8Array(10);
      }
    }
    await expect(collectBytes(endless(), { maxBytes: 25 })).rejects.toThrow();
    expect(pulled).toBe(3);
  });
});

describe("collectText", () => {
  it("decodes UTF-8", async () => {
    expect(await collectText(stream("hé", "llo"))).toBe("héllo");
  });

  it("throws when the input exceeds maxBytes", async () => {
    await expect(collectText(stream("hello"), { maxBytes: 3 })).rejects.toThrow(/exceeds/);
  });
});
