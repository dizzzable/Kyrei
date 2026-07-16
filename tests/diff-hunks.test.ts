import { describe, it, expect } from "vitest";
import {
  parseLineDiffHunks,
  applyHunksToOldText,
  applyHunkDecisions,
  aggregateHunkStatus,
} from "../core/diff-hunks.js";

describe("diff-hunks", () => {
  it("parses LCS-style line diff into hunks", () => {
    const diff = [
      " line1",
      "-oldA",
      "+newA",
      " line2",
      "-oldB",
      "+newB",
    ].join("\n");
    const { ops, hunks } = parseLineDiffHunks(diff);
    expect(ops).toHaveLength(6);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.id).toBe("h0");
    expect(hunks[0]!.preview).toContain("-oldA");
  });

  it("applies only accepted hunks onto old text", () => {
    const oldText = "line1\noldA\nline2\noldB";
    const diff = [
      " line1",
      "-oldA",
      "+newA",
      " line2",
      "-oldB",
      "+newB",
    ].join("\n");
    const { ops, hunks } = parseLineDiffHunks(diff);
    const decided = applyHunkDecisions(hunks, [
      { id: "h0", accept: true },
      { id: "h1", accept: false },
    ]);
    expect(aggregateHunkStatus(decided)).toBe("partial");
    const next = applyHunksToOldText(oldText, ops, decided);
    expect(next).toBe("line1\nnewA\nline2\noldB");
  });

  it("accept-all yields all new sides", () => {
    const oldText = "a\nb";
    const diff = ["-a", "+A", "-b", "+B"].join("\n");
    const { ops, hunks } = parseLineDiffHunks(diff);
    const decided = applyHunkDecisions(hunks, hunks.map((h) => ({ id: h.id, accept: true })));
    expect(applyHunksToOldText(oldText, ops, decided)).toBe("A\nB");
  });
});
