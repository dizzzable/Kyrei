import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { relative, isAbsolute } from "node:path";
import { safePath } from "./jail.js";

const WS = process.platform === "win32" ? "F:\\ws" : "/ws";

describe("jail — Property 1: safePath never escapes the workspace", () => {
  it("returns a path within workspace or throws", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (target) => {
        let abs: string;
        try {
          abs = safePath(WS, target);
        } catch {
          return true; // rejection is acceptable
        }
        const rel = relative(WS, abs);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      }),
      { numRuns: 500, seed: 42 },
    );
  });

  it("rejects explicit parent-escape", () => {
    expect(() => safePath(WS, "../secret")).toThrow();
    expect(() => safePath(WS, "a/../../secret")).toThrow();
  });

  it("allows nested paths", () => {
    expect(() => safePath(WS, "src/app.ts")).not.toThrow();
  });
});
