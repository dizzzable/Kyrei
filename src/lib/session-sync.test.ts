import { describe, expect, it } from "vitest";
import {
  reconcileCurrentSessionId,
  rollbackSessionModel,
  shouldApplySessionPoll,
  updateSessionModel,
} from "./session-sync";

describe("session synchronization", () => {
  it("rejects an older overlapping poll", () => {
    expect(shouldApplySessionPoll({
      requestId: 4,
      latestRequestId: 5,
      revisionAtStart: 8,
      currentRevision: 8,
      mutationsInFlight: 0,
    })).toBe(false);
  });

  it("rejects polls spanning or observing a local mutation", () => {
    expect(shouldApplySessionPoll({
      requestId: 5,
      latestRequestId: 5,
      revisionAtStart: 7,
      currentRevision: 8,
      mutationsInFlight: 0,
    })).toBe(false);
    expect(shouldApplySessionPoll({
      requestId: 5,
      latestRequestId: 5,
      revisionAtStart: 8,
      currentRevision: 8,
      mutationsInFlight: 1,
    })).toBe(false);
  });

  it("accepts the latest stable poll", () => {
    expect(shouldApplySessionPoll({
      requestId: 5,
      latestRequestId: 5,
      revisionAtStart: 8,
      currentRevision: 8,
      mutationsInFlight: 0,
    })).toBe(true);
  });

  it("falls back when the selected remote session disappears", () => {
    expect(reconcileCurrentSessionId("removed", [{ id: "next" }, { id: "later" }])).toBe("next");
    expect(reconcileCurrentSessionId("removed", [])).toBeNull();
    expect(reconcileCurrentSessionId("next", [{ id: "next" }])).toBe("next");
  });

  it("does not invent a selection during initial hydration", () => {
    expect(reconcileCurrentSessionId(null, [{ id: "first" }])).toBeNull();
  });

  it("updates one session model without touching the rest", () => {
    const sessions = [
      { id: "first", title: "", createdAt: "now", providerId: "old", modelId: "old-model" },
      { id: "second", title: "", createdAt: "now", providerId: "keep", modelId: "keep-model" },
    ];

    expect(updateSessionModel(sessions, "first", { providerId: "next", modelId: "next-model" })).toEqual([
      { ...sessions[0], providerId: "next", modelId: "next-model" },
      sessions[1],
    ]);
  });

  it("rolls back only the optimistic model target that actually failed", () => {
    const previous = { providerId: "old", modelId: "old-model" };
    const optimistic = { providerId: "next", modelId: "next-model" };
    const base = [{ id: "first", title: "", createdAt: "now", ...optimistic }];

    expect(rollbackSessionModel(base, "first", optimistic, previous)[0]).toMatchObject(previous);
    expect(rollbackSessionModel(
      [{ ...base[0], providerId: "newer", modelId: "newer-model" }],
      "first",
      optimistic,
      previous,
    )[0]).toMatchObject({ providerId: "newer", modelId: "newer-model" });
  });
});
