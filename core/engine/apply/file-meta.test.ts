import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { detectMeta, decodeToLines, serialize } from "./file-meta.js";

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);

describe("file-meta — byte round trip (Property 9: EOL/BOM/final-newline preserved)", () => {
  it("serialize(decode(buf), detectMeta(buf)) === buf for uniform-EOL text", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, "")), { minLength: 1, maxLength: 30 }),
        fc.constantFrom<"\n" | "\r\n">("\n", "\r\n"),
        fc.boolean(),
        fc.boolean(),
        (lines, eol, finalNewline, hasBom) => {
          let text = lines.join(eol);
          if (finalNewline) text += eol;
          const buf = hasBom ? Buffer.concat([BOM_UTF8, Buffer.from(text, "utf8")]) : Buffer.from(text, "utf8");
          const meta = detectMeta(buf);
          const reserialized = serialize(decodeToLines(buf, meta), meta);
          return reserialized.equals(buf);
        },
      ),
      { numRuns: 300, seed: 42 },
    );
  });

  it("detects binary (NUL byte)", () => {
    expect(detectMeta(Buffer.from([0x61, 0x00, 0x62])).encoding).toBe("binary");
  });

  it("preserves UTF-8 BOM", () => {
    const buf = Buffer.concat([BOM_UTF8, Buffer.from("hello\n", "utf8")]);
    const meta = detectMeta(buf);
    expect(meta.bom).toBe("utf8");
    expect(serialize(decodeToLines(buf, meta), meta).equals(buf)).toBe(true);
  });
});
