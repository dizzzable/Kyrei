import { describe, it, expect } from "vitest";
import {
  applyFileReviewDecisions,
  aggregateFileReviewStatus,
  snapshotIdsForRejected,
  collectSessionFileChanges,
  applyHunkDecisionsToFile,
  finalizeFileFromHunks,
  needsSelectiveHunkApply,
  withAggregatedReview,
} from "../core/session-file-review.js";

describe("session-file-review (gateway helpers)", () => {
  it("links shared snapshot on reject", () => {
    const next = applyFileReviewDecisions(
      {
        status: "pending",
        snapshotIds: ["s1"],
        files: [
          { path: "a.ts", tool: "write_file", snapshotId: "s1", status: "pending" },
          { path: "b.ts", tool: "edit_file", snapshotId: "s1", status: "pending" },
        ],
      },
      [{ path: "a.ts", accept: false }],
    );
    expect(next.files.every((f) => f.status === "rejected")).toBe(true);
    expect(next.status).toBe("rejected");
    expect(snapshotIdsForRejected(next.files)).toEqual(["s1"]);
  });

  it("aggregates partial", () => {
    expect(aggregateFileReviewStatus([
      { path: "a", tool: "write_file", status: "accepted" },
      { path: "b", tool: "write_file", status: "rejected" },
    ])).toBe("partial");
  });

  it("collects session changes", () => {
    const changes = collectSessionFileChanges([
      {
        id: "m1",
        role: "assistant",
        parts: [
          {
            type: "tool",
            name: "write_file",
            args: { path: "x.ts" },
            snapshotId: "snap",
            result: "ok",
          },
        ],
      },
    ]);
    expect(changes[0]).toMatchObject({ path: "x.ts", snapshotId: "snap" });
  });

  it("mixed hunk decisions finalize as accepted + selective apply", () => {
    const file = {
      path: "a.ts",
      tool: "write_file",
      snapshotId: "s1",
      status: "pending" as const,
      diffOps: [
        { kind: " " as const, text: "keep" },
        { kind: "-" as const, text: "old" },
        { kind: "+" as const, text: "new" },
        { kind: "-" as const, text: "drop" },
        { kind: "+" as const, text: "kept-new" },
      ],
      hunks: [
        { id: "h0", status: "pending" as const, start: 1, end: 3, preview: "-old\n+new" },
        { id: "h1", status: "pending" as const, start: 3, end: 5, preview: "-drop\n+kept-new" },
      ],
    };
    const mid = applyHunkDecisionsToFile(file, [{ id: "h0", accept: true }]);
    expect(mid.status).toBe("pending");
    const done = applyHunkDecisionsToFile(mid, [{ id: "h1", accept: false }]);
    expect(done.status).toBe("accepted");
    expect(finalizeFileFromHunks(done).status).toBe("accepted");
    expect(needsSelectiveHunkApply(done)).toBe(true);
    const review = withAggregatedReview({ status: "pending", snapshotIds: ["s1"], files: [] }, [done]);
    expect(review.status).toBe("accepted");
  });

  it("all hunks rejected → file rejected", () => {
    const file = {
      path: "a.ts",
      tool: "write_file",
      status: "pending" as const,
      hunks: [
        { id: "h0", status: "pending" as const, start: 0, end: 1, preview: "+" },
      ],
    };
    const done = applyHunkDecisionsToFile(file, [{ id: "h0", accept: false }]);
    expect(done.status).toBe("rejected");
    expect(needsSelectiveHunkApply(done)).toBe(false);
  });
});
