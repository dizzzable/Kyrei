import { describe, expect, it } from "vitest";
import { timeoutForPath } from "./gateway";

/**
 * Every REST call carries a deadline so a wedged gateway cannot leave an
 * unbounded spinner. A single 30s deadline for ALL of them was wrong in the
 * other direction: it aborted long jobs CLIENT-side while the server kept
 * working, so the UI reported a timeout and the user retried — producing a
 * second package install or a concurrent reindex.
 */
describe("REST deadlines match what the endpoint actually does", () => {
  const LONG = 15 * 60_000;
  const SHORT = 30_000;

  it.each([
    "/api/memory/gbrain/install",
    "/api/memory/gbrain/initialize",
    "/api/memory/index/reindex",
    "/api/evolution/evaluate",
  ])("gives %s room to finish", (path) => {
    expect(timeoutForPath(path)).toBe(LONG);
  });

  it.each([
    "/api/config",
    "/api/sessions",
    "/api/prompt",
    "/api/memory/graph",
    "/api/status",
  ])("keeps %s on the short deadline", (path) => {
    expect(timeoutForPath(path)).toBe(SHORT);
  });

  it("matches on prefix so a query string does not change the deadline", () => {
    expect(timeoutForPath("/api/evolution/evaluate?force=1")).toBe(LONG);
  });

  it("does not let a similar-looking path inherit the long deadline", () => {
    // `/api/evolution/candidates` is an ordinary list read.
    expect(timeoutForPath("/api/evolution/candidates")).toBe(SHORT);
    expect(timeoutForPath("/api/memory/index/status")).toBe(SHORT);
  });

  it("still bounds the long ones — a deadline, not unbounded", () => {
    expect(timeoutForPath("/api/memory/gbrain/install")).toBeLessThan(Number.POSITIVE_INFINITY);
  });
});
