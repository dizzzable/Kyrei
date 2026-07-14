import { describe, expect, it } from "vitest";
import {
  cancelResponseIsTerminal,
  mergeSessionHydration,
  pendingAssistantId,
  reconcileCurrentSessionId,
  rollbackSessionModel,
  runStateForSession,
  shouldApplySessionPoll,
  updateSessionModel,
} from "./session-sync";

describe("session synchronization", () => {
  it("keeps a stopping turn busy until the gateway confirms a terminal state", () => {
    expect(runStateForSession("working", "stopping")).toBe("stopping");
    expect(runStateForSession("working", "idle")).toBe("running");
    expect(runStateForSession("idle", "stopping")).toBe("idle");
  });

  it("accepts only explicit terminal cancel acknowledgements", () => {
    expect(cancelResponseIsTerminal({ ok: true, cancelled: true })).toBe(true);
    expect(cancelResponseIsTerminal({ ok: true, cancelled: false, status: "cancelled" })).toBe(true);
    expect(cancelResponseIsTerminal({ ok: true, cancelled: false, status: "idle" })).toBe(true);
    expect(cancelResponseIsTerminal({ ok: true, cancelled: false, status: "interrupted" })).toBe(true);
    expect(cancelResponseIsTerminal({ ok: true })).toBe(false);
    expect(cancelResponseIsTerminal({ ok: true, cancelled: false, status: "timeout" })).toBe(false);
  });

  it("merges durable hydration without dropping live deltas from a restored active turn", () => {
    const pendingId = pendingAssistantId("session-a");
    const durable = [{ id: "user-1", role: "user" as const, parts: [{ type: "text" as const, text: "question" }] }];
    const live = [{
      id: pendingId,
      role: "assistant" as const,
      parts: [{ type: "reasoning" as const, text: "live delta" }],
      pending: true,
    }];

    expect(mergeSessionHydration(durable, live, pendingId, true)).toEqual({
      messages: [durable[0], live[0]],
      pendingId,
    });
    expect(mergeSessionHydration(durable, [], pendingId, true)).toEqual({
      messages: [
        durable[0],
        { id: pendingId, role: "assistant", parts: [{ type: "reasoning", text: "" }], pending: true },
      ],
      pendingId,
    });
    expect(mergeSessionHydration(durable, live, pendingId, false)).toEqual({
      messages: durable,
      pendingId: null,
    });
  });

  it("replaces a synthetic pending row with the canonical durable draft id", () => {
    const syntheticId = pendingAssistantId("session-a");
    const canonicalId = "msg-canonical";
    const durable = [
      { id: "user-1", role: "user" as const, parts: [{ type: "text" as const, text: "question" }] },
      { id: canonicalId, role: "assistant" as const, parts: [], pending: true },
    ];
    const live = [{
      id: syntheticId,
      role: "assistant" as const,
      parts: [{ type: "reasoning" as const, text: "newer live delta" }],
      pending: true,
    }];

    expect(mergeSessionHydration(durable, live, syntheticId, true, canonicalId)).toEqual({
      messages: [
        durable[0],
        { ...durable[1], parts: live[0].parts },
      ],
      pendingId: canonicalId,
    });
  });

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
