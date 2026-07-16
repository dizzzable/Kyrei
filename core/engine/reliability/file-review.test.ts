import { describe, it, expect } from "vitest";
import {
  collectFileReviewFromParts,
  canEnterFileReview,
  applyFileReviewDecisions,
  aggregateFileReviewStatus,
  snapshotIdsForRejected,
  collectSessionFileChanges,
} from "./file-review.js";
import type { MessagePart } from "../types.js";
import { matchesProtectedPath } from "../security/permissions.js";

describe("file-review collection", () => {
  it("returns null when no file tools ran", () => {
    const parts: MessagePart[] = [
      { type: "text", text: "hi" },
      { type: "tool", toolCallId: "1", name: "read_file", running: false, result: "ok" },
    ];
    expect(collectFileReviewFromParts(parts)).toBeNull();
  });

  it("collects successful write/edit tools and snapshot ids with per-file pending", () => {
    const parts: MessagePart[] = [
      {
        type: "tool",
        toolCallId: "w1",
        name: "write_file",
        args: { path: "src/a.ts" },
        snapshotId: "snap-a",
        running: false,
        result: "ok",
        inlineDiff: "+hello",
      },
      {
        type: "tool",
        toolCallId: "e1",
        name: "edit_file",
        args: { path: "src/b.ts" },
        snapshotId: "snap-b",
        running: false,
        result: "ok",
      },
      {
        type: "tool",
        toolCallId: "fail",
        name: "write_file",
        args: { path: "src/c.ts" },
        running: false,
        error: "denied",
      },
    ];
    const review = collectFileReviewFromParts(parts);
    expect(review).toMatchObject({
      status: "pending",
      files: [
        { path: "src/a.ts", tool: "write_file", snapshotId: "snap-a", status: "pending", diffPreview: "+hello" },
        { path: "src/b.ts", tool: "edit_file", snapshotId: "snap-b", status: "pending" },
      ],
      snapshotIds: ["snap-a", "snap-b"],
    });
  });

  it("canEnterFileReview only for soft-success terminals", () => {
    expect(canEnterFileReview("complete")).toBe(true);
    expect(canEnterFileReview("max_steps")).toBe(true);
    expect(canEnterFileReview("error")).toBe(false);
    expect(canEnterFileReview("interrupted")).toBe(false);
    expect(canEnterFileReview("awaiting_approval")).toBe(false);
  });

  it("applies per-file decisions and links shared snapshots", () => {
    const review = {
      status: "pending" as const,
      snapshotIds: ["s1", "s2"],
      files: [
        { path: "a.ts", tool: "write_file", snapshotId: "s1", status: "pending" as const },
        { path: "b.ts", tool: "edit_file", snapshotId: "s1", status: "pending" as const },
        { path: "c.ts", tool: "write_file", snapshotId: "s2", status: "pending" as const },
      ],
    };
    const next = applyFileReviewDecisions(review, [{ path: "a.ts", accept: false }]);
    expect(next.files[0]!.status).toBe("rejected");
    expect(next.files[1]!.status).toBe("rejected"); // same snapshot
    expect(next.files[2]!.status).toBe("pending");
    expect(next.status).toBe("pending");
    const done = applyFileReviewDecisions(next, [{ path: "c.ts", accept: true }]);
    expect(done.status).toBe("partial");
    expect(snapshotIdsForRejected(done.files)).toEqual(["s1"]);
  });

  it("aggregateFileReviewStatus", () => {
    expect(aggregateFileReviewStatus([
      { path: "a", tool: "write_file", status: "accepted" },
      { path: "b", tool: "write_file", status: "accepted" },
    ])).toBe("accepted");
    expect(aggregateFileReviewStatus([
      { path: "a", tool: "write_file", status: "rejected" },
      { path: "b", tool: "write_file", status: "rejected" },
    ])).toBe("rejected");
  });

  it("collectSessionFileChanges walks history", () => {
    const changes = collectSessionFileChanges([
      {
        id: "m1",
        role: "assistant",
        at: "t1",
        parts: [
          {
            type: "tool",
            toolCallId: "1",
            name: "write_file",
            args: { path: "x.ts" },
            snapshotId: "snap",
            running: false,
            result: "ok",
          },
        ],
      },
    ]);
    expect(changes).toEqual([
      expect.objectContaining({ messageId: "m1", path: "x.ts", tool: "write_file", snapshotId: "snap" }),
    ]);
  });
});

describe("matchesProtectedPath", () => {
  it("matches basename and path contains patterns", () => {
    expect(matchesProtectedPath("foo/mcp.json", ["mcp.json"])).toBe(true);
    expect(matchesProtectedPath("mcp.json.bak", ["mcp.json"])).toBe(false);
    expect(matchesProtectedPath("src/.git/config", [".git/"])).toBe(true);
    expect(matchesProtectedPath("readme.md", [".git/"])).toBe(false);
  });
});

describe("file-review hunk collection", () => {
  it("attaches hunks from inlineDiff", () => {
    const parts: MessagePart[] = [
      {
        type: "tool",
        toolCallId: "w1",
        name: "write_file",
        args: { path: "src/a.ts" },
        snapshotId: "snap-a",
        running: false,
        result: "ok",
        inlineDiff: [" line1", "-old", "+new", " line2"].join("\n"),
      },
    ];
    const review = collectFileReviewFromParts(parts);
    expect(review?.files[0]?.hunks?.length).toBe(1);
    expect(review?.files[0]?.diffOps?.length).toBe(4);
    expect(review?.files[0]?.hunks?.[0]?.id).toBe("h0");
  });
});
