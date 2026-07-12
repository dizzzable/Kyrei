import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { seekSequence, normalizeUnicode } from "./seek.js";

describe("seek — levels", () => {
  it("exact unique match", () => {
    const r = seekSequence(["a", "b", "c"], ["b"]);
    expect(r.found).toBe(true);
    expect(r.index).toBe(1);
    expect(r.level).toBe(0);
  });

  it("tolerates trailing whitespace at level 1", () => {
    const r = seekSequence(["a", "b   ", "c"], ["b"]);
    expect(r.found).toBe(true);
    expect(r.level).toBe(1);
  });

  it("tolerates indentation at level 2", () => {
    const r = seekSequence(["    return x;"], ["return x;"]);
    expect(r.found).toBe(true);
    expect(r.level).toBe(2);
  });

  it("normalizes unicode punctuation at level 3", () => {
    // em-dash + curly quote in file, ascii in needle
    const r = seekSequence(["const s = \u201Chi\u201D;"], ['const s = "hi";']);
    expect(r.found).toBe(true);
    expect(r.level).toBe(3);
  });

  it("ambiguous → found=false, matches>1", () => {
    const r = seekSequence(["dup", "x", "dup"], ["dup"]);
    expect(r.found).toBe(false);
    expect(r.matches).toHaveLength(2);
  });

  it("not found → matches=0", () => {
    const r = seekSequence(["a", "b"], ["zzz"]);
    expect(r.matches).toHaveLength(0);
  });
});

describe("normalizeUnicode", () => {
  it("maps dashes/quotes/nbsp/zero-width", () => {
    expect(normalizeUnicode("a\u2014b\u00A0c\u200Bd\u2019e")).toBe("a-b cd'e");
  });
});

describe("seek — property: uniquely inserted needle matches exactly once", () => {
  it("holds for random base lines", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 40 }), fc.nat(), (base, pos) => {
        const clean = base.filter((s) => s !== "__KYREI_ANCHOR__" && !/[\r\n]/.test(s));
        const at = clean.length === 0 ? 0 : pos % (clean.length + 1);
        const hay = [...clean.slice(0, at), "__KYREI_ANCHOR__", ...clean.slice(at)];
        const r = seekSequence(hay, ["__KYREI_ANCHOR__"]);
        return r.found && r.matches.length === 1 && r.index === at;
      }),
      { numRuns: 300, seed: 42 },
    );
  });
});
