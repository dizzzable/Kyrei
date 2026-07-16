import { describe, it, expect } from "vitest";
import { orderSessionsWithForkTree } from "./session-fork-tree";
import type { SessionInfo } from "@/lib/types";

function sess(partial: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    title: partial.id,
    updatedAt: partial.updatedAt ?? "2026-07-16T12:00:00.000Z",
    ...partial,
  };
}

describe("orderSessionsWithForkTree", () => {
  it("nests branch children under visible parent", () => {
    const rows = orderSessionsWithForkTree([
      sess({ id: "child", parentSessionId: "root", lineageKind: "branch", updatedAt: "2026-07-16T13:00:00.000Z" }),
      sess({ id: "root", updatedAt: "2026-07-16T12:00:00.000Z" }),
      sess({ id: "other", updatedAt: "2026-07-16T14:00:00.000Z" }),
    ]);
    expect(rows.map((r) => `${r.depth}:${r.session.id}`)).toEqual([
      "0:other",
      "0:root",
      "1:child",
    ]);
  });

  it("keeps orphan forks as roots when parent missing", () => {
    const rows = orderSessionsWithForkTree([
      sess({ id: "orphan", parentSessionId: "gone", lineageKind: "branch" }),
    ]);
    expect(rows).toEqual([{ session: expect.objectContaining({ id: "orphan" }), depth: 0 }]);
  });

  it("nests multi-level when all present", () => {
    const rows = orderSessionsWithForkTree([
      sess({ id: "a" }),
      sess({ id: "b", parentSessionId: "a", lineageKind: "branch" }),
      sess({ id: "c", parentSessionId: "b", lineageKind: "branch" }),
    ]);
    expect(rows.map((r) => `${r.depth}:${r.session.id}`)).toEqual([
      "0:a",
      "1:b",
      "2:c",
    ]);
  });
});
