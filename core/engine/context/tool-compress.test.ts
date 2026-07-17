import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compressJson,
  compressLog,
  compressToolOutput,
  compressToolOutputSync,
  detectToolContentKind,
} from "./tool-compress.js";
import { createCcrStore } from "./ccr.js";
import { createReadMemo, contentFingerprint } from "./read-memo.js";

describe("tool-compress (Wave B1)", () => {
  it("detects common shapes", () => {
    expect(detectToolContentKind('{"a":1,"b":[1,2,3]}')).toBe("json");
    expect(detectToolContentKind("INFO start\nERROR boom\nWARN again\nINFO ok\nERROR x\nWARN y\nINFO z\nERROR end")).toBe("log");
    expect(detectToolContentKind("Error: x\n    at foo (a.js:1:1)\n    at bar (b.js:2:2)")).toBe("stack");
    expect(detectToolContentKind("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new")).toBe("diff");
    expect(detectToolContentKind("import x from 'y';\nexport function f() {}\nconst a = 1;\nclass C {}\nfunction g() {}\nlet z = 2;")).toBe("code");
  });

  it("compresses JSON under budget and keeps structure", () => {
    const big = JSON.stringify({
      items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `n${i}`, pad: "x".repeat(50) })),
    });
    const out = compressJson(big, 1_500);
    expect(out.length).toBeLessThan(big.length);
    expect(out.length).toBeLessThanOrEqual(1_500);
    expect(out).toContain("items");
  });

  it("keeps error lines when compressing logs", () => {
    const lines = [
      ...Array.from({ length: 40 }, (_, i) => `INFO line ${i}`),
      "ERROR something failed",
      ...Array.from({ length: 40 }, (_, i) => `DEBUG noise ${i}`),
    ];
    const text = lines.join("\n");
    const out = compressLog(text, 800);
    expect(out).toContain("ERROR something failed");
    expect(out.length).toBeLessThan(text.length);
  });

  it("stores full body in CCR when over budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kyrei-tc-"));
    try {
      const ccr = createCcrStore(dir);
      const big = "LINE\n".repeat(5_000);
      const result = await compressToolOutput(big, { maxChars: 600, ccr, toolName: "run_command" });
      expect(result.compressed).toBe(true);
      expect(result.hash).toMatch(/^sha256:/);
      expect(result.text).toContain("tool-compress");
      expect(result.text.length).toBeLessThanOrEqual(600);
      expect(await ccr.get(result.hash!)).toBe(big);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sync path compresses without CCR", () => {
    const big = "const x = 1;\n".repeat(2_000);
    const result = compressToolOutputSync(big, { maxChars: 500, toolName: "read_file" });
    expect(result.compressed).toBe(true);
    expect(result.text).toContain("tool-compress");
    expect(result.text.length).toBeLessThanOrEqual(500);
  });
});

describe("read-memo (Wave B4)", () => {
  it("returns full content once then path@hash stub", () => {
    const memo = createReadMemo();
    const body = "export const answer = 42;\n";
    const first = memo.note("src/a.ts", body);
    expect(first.hit).toBe(false);
    expect(first.text).toBe(body);
    expect(first.hash).toBe(contentFingerprint(body));

    const second = memo.note("src/a.ts", body);
    expect(second.hit).toBe(true);
    expect(second.text).toContain("read-memo");
    expect(second.text).toContain("src/a.ts@");
    expect(second.text).not.toContain("export const answer");

    memo.invalidate("src/a.ts");
    const third = memo.note("src/a.ts", body);
    expect(third.hit).toBe(false);
    expect(third.text).toBe(body);
  });

  it("treats changed content as a miss", () => {
    const memo = createReadMemo();
    memo.note("f.ts", "v1");
    const next = memo.note("f.ts", "v2");
    expect(next.hit).toBe(false);
    expect(next.text).toBe("v2");
  });
});
