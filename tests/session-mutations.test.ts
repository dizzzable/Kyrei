import { describe, it, expect } from "vitest";
import {
  resolveApprovalInMessages,
  consumeApprovalInMessages,
  planRewindInMessages,
  commitRewindInMessages,
  SessionMutationError,
} from "../core/session-mutations.js";

const baseMessages = [
  { id: "msg-u1", role: "user", content: "do it", text: "do it", parts: [{ type: "text", text: "do it" }] },
  {
    id: "msg-a1",
    role: "assistant",
    content: "need ok",
    parts: [
      {
        type: "approval",
        approvalId: "appr-long-1",
        toolCallId: "call-long-1",
        name: "run_command",
        reason: "ask",
        status: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ],
    approvalModelParams: { effort: "low" },
  },
];

describe("session-mutations pure algorithms", () => {
  it("resolves pending approval to approved and marks ready", () => {
    const r = resolveApprovalInMessages(baseMessages, "appr-long-1", { approved: true });
    expect(r.ready).toBe(true);
    expect(r.approval.status).toBe("approved");
    expect(r.modelParams).toEqual({ effort: "low" });
    expect(baseMessages[1]!.parts[0]!.status).toBe("pending"); // immutable source
    expect(r.messages[1]!.parts[0]!.status).toBe("approved");
  });

  it("denies and consumes immediately", () => {
    const r = resolveApprovalInMessages(baseMessages, "appr-long-1", { approved: false, reason: "nope" });
    expect(r.approval.status).toBe("denied");
    expect(r.approval.consumedAt).toBeTruthy();
    expect(r.approval.decisionReason).toBe("nope");
  });

  it("throws on missing approval", () => {
    expect(() => resolveApprovalInMessages(baseMessages, "missing", { approved: true }))
      .toThrow(SessionMutationError);
  });

  it("consumes resolved approval", () => {
    const resolved = resolveApprovalInMessages(baseMessages, "appr-long-1", { approved: true });
    const c = consumeApprovalInMessages(resolved.messages, "appr-long-1");
    expect(c.approval.consumedAt).toBeTruthy();
  });

  it("plans and commits rewind at user message", () => {
    const msgs = [
      { id: "msg-1", role: "user", content: "a" },
      { id: "msg-2", role: "assistant", content: "b", parts: [{ type: "tool", snapshotId: "snap-keep" }] },
      { id: "msg-3", role: "user", content: "c" },
      { id: "msg-4", role: "assistant", content: "d", parts: [{ type: "tool", snapshotId: "snap-1" }] },
    ];
    const plan = planRewindInMessages(msgs, "msg-3", { id: "s1" });
    expect(plan).toBeTruthy();
    // Snapshots only from truncated tail (from user message onward).
    expect(plan!.snapshotIds).toEqual(["snap-1"]);
    expect(plan!.index).toBe(2);
    const committed = commitRewindInMessages(msgs, plan!);
    expect(committed.ok).toBe(true);
    expect(committed.messages).toHaveLength(2);
    expect(committed.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
  });
});
