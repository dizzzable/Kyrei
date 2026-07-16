import { describe, it, expect } from "vitest";
import { lexicalEmbed, isZeroVector, LEXICAL_EMBED_DIM } from "./lexical-embed.js";

describe("lexicalEmbed", () => {
  it("is deterministic and L2-normalized", () => {
    const a = lexicalEmbed("Prefer local SQLite memory");
    const b = lexicalEmbed("Prefer local SQLite memory");
    expect(a.length).toBe(LEXICAL_EMBED_DIM);
    expect([...a]).toEqual([...b]);
    let norm = 0;
    for (let i = 0; i < a.length; i++) norm += a[i]! * a[i]!;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it("ranks similar text closer than unrelated text", () => {
    const q = lexicalEmbed("architectural decision sqlite offline");
    const close = lexicalEmbed("Use SQLite for offline architectural decisions");
    const far = lexicalEmbed("banana smoothie recipe with mango");
    const cosine = (x: Float32Array, y: Float32Array): number => {
      let dot = 0;
      for (let i = 0; i < x.length; i++) dot += x[i]! * y[i]!;
      return dot;
    };
    expect(cosine(q, close)).toBeGreaterThan(cosine(q, far));
  });

  it("returns zero vector for empty input", () => {
    expect(isZeroVector(lexicalEmbed(""))).toBe(true);
    expect(isZeroVector(lexicalEmbed("  \n"))).toBe(true);
  });
});
