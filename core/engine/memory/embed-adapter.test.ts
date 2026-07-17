import { describe, expect, it } from "vitest";
import { splitTextForEmbedding } from "./embed-adapter.js";

describe("embedding chunking", () => {
  it("keeps short bodies as one chunk", () => {
    expect(splitTextForEmbedding("short body")).toEqual(["short body"]);
  });

  it("uses overlap and preserves the tail under the chunk cap", () => {
    const body = `${"alpha ".repeat(900)}\nTAIL_CHUNK_TOKEN`;
    const chunks = splitTextForEmbedding(body, { maxChars: 256, overlap: 32, maxChunks: 4 });

    expect(chunks).toHaveLength(4);
    expect(chunks.every((chunk) => chunk.length <= 256)).toBe(true);
    expect(chunks.some((chunk) => chunk.includes("TAIL_CHUNK_TOKEN"))).toBe(true);
    expect(chunks[0]!.slice(-32)).toBe(chunks[1]!.slice(0, 32));
  });
});
