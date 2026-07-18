import { describe, expect, it } from "vitest";
import { SessionStore } from "../core/session-store.js";

describe("session store localization migration", () => {
  it("clears legacy localized placeholders only for empty sessions", () => {
    const store = new SessionStore({ runtimeDir: "." });
    const migrated = store.migrate({
      schemaVersion: 1,
      sessions: [
        { id: "empty-ru", title: "Новый диалог" },
        { id: "empty-en", title: "New session" },
        { id: "used", title: "New session" },
        { id: "custom", title: "My session" },
      ],
      messages: { used: [{ role: "user", content: "Keep the explicit title" }] },
    });

    expect(migrated.schemaVersion).toBe(7);
    // normalizeSessionRecord always materializes archived: false for active chats.
    expect(migrated.sessions).toEqual([
      { id: "empty-ru", title: "", archived: false },
      { id: "empty-en", title: "", archived: false },
      { id: "used", title: "New session", archived: false },
      { id: "custom", title: "My session", archived: false },
    ]);
  });

  it("preserves bounded provider and model overrides", () => {
    const store = new SessionStore({ runtimeDir: "." });
    const migrated = store.migrate({
      schemaVersion: 2,
      sessions: [
        { id: "valid", title: "Chat", providerId: "provider", modelId: "model", providerAccountId: "backup-1" },
        { id: "invalid", title: "Chat", providerId: { nested: true }, modelId: "", providerAccountId: "../secret" },
      ],
      messages: {},
    });
    expect(migrated.sessions).toEqual([
      {
        id: "valid",
        title: "Chat",
        providerId: "provider",
        modelId: "model",
        providerAccountId: "backup-1",
        archived: false,
      },
      { id: "invalid", title: "Chat", archived: false },
    ]);
  });

  it("clears a stale account binding without changing the provider target", () => {
    const store = new SessionStore({ runtimeDir: "." });
    store.upsertSession({
      id: "session",
      providerId: "provider",
      modelId: "model",
      providerAccountId: "backup",
    });
    store.upsertSession({ id: "session", providerAccountId: undefined });
    expect(store.getSession("session")).toEqual({
      id: "session",
      providerId: "provider",
      modelId: "model",
      archived: false,
    });
  });

  it("assigns stable ids to legacy messages and preserves explicit client ids", () => {
    const store = new SessionStore({ runtimeDir: "." });
    const migrated = store.migrate({
      schemaVersion: 4,
      sessions: [{ id: "session", title: "Chat" }],
      messages: {
        session: [
          { role: "user", content: "legacy" },
          { id: "msg-client-12345678", role: "assistant", content: "kept" },
        ],
      },
    });

    expect(migrated.messages.session[0].id).toBe("msg-legacy-session-0");
    expect(migrated.messages.session[1].id).toBe("msg-client-12345678");
  });

  it("recovers a persisted active assistant draft as an interrupted turn", () => {
    const store = new SessionStore({ runtimeDir: "." });
    const migrated = store.migrate({
      schemaVersion: 6,
      sessions: [{ id: "session", title: "Interrupted" }],
      messages: {
        session: [{
          id: "msg-assistant-active-0001",
          role: "assistant",
          content: "Partial answer",
          pending: true,
          turnStatus: "streaming",
          parts: [
            { type: "reasoning", text: "Checked the repository" },
            {
              type: "tool",
              toolCallId: "call-active",
              name: "delegate_read",
              args: { task: "Inspect the project" },
              progress: "Still working",
              running: true,
            },
            { type: "text", text: "Partial answer" },
          ],
        }],
      },
    });

    expect(migrated.messages.session).toEqual([
      expect.objectContaining({
        id: "msg-assistant-active-0001",
        role: "assistant",
        content: "Partial answer",
        pending: false,
        turnStatus: "interrupted",
        parts: [
          { type: "reasoning", text: "Checked the repository" },
          expect.objectContaining({
            type: "tool",
            toolCallId: "call-active",
            running: false,
            error: "tool_interrupted",
            progress: undefined,
          }),
          { type: "text", text: "Partial answer" },
        ],
      }),
    ]);
  });

  it("migrates a leaked heal handoff block into structured assistant metadata", () => {
    const store = new SessionStore({ runtimeDir: "." });
    const leaked = [
      "Partial finding",
      "",
      "KYREI_FAILURE_HANDOFF",
      "[heal-handoff] consecutive tool failures (3-strike) — handoff written: /home/user/.kyrei/handoff/private.md",
      "Stop thrashing identical retries; human takes the wheel.",
    ].join("\n");
    const migrated = store.migrate({
      schemaVersion: 7,
      sessions: [{ id: "session", title: "Recovered" }],
      messages: {
        session: [{
          role: "assistant",
          content: leaked,
          parts: [{ type: "text", text: leaked }],
        }],
      },
    });

    expect(migrated.messages.session[0]).toMatchObject({
      role: "assistant",
      content: "Partial finding",
      parts: [{ type: "text", text: "Partial finding" }],
      errorCode: "heal_handoff",
      turnStatus: "heal_handoff",
    });
    expect(JSON.stringify(migrated.messages.session[0])).not.toContain("private.md");
    expect(JSON.stringify(migrated.messages.session[0])).not.toContain("KYREI_FAILURE_HANDOFF");
  });

  it("plans and commits a rewind at a user message with ordered snapshot ids", () => {
    const store = new SessionStore({ runtimeDir: "." });
    store.upsertSession({ id: "session", title: "Chat" });
    store.appendMessage("session", { id: "msg-user-00000001", role: "user", content: "first" });
    store.appendMessage("session", {
      id: "msg-assistant-0001",
      role: "assistant",
      content: "changed",
      parts: [{ type: "tool", name: "edit_file", toolCallId: "call", running: false, snapshotId: "snap-old" }],
    });
    store.appendMessage("session", { id: "msg-user-00000002", role: "user", content: "retry this", workspace: "C:/workspace" });
    store.appendMessage("session", {
      id: "msg-assistant-0002",
      role: "assistant",
      content: "changed again",
      parts: [{ type: "tool", name: "write_file", toolCallId: "call-2", running: false, snapshotId: "snap-new" }],
    });

    const plan = store.planRewind("session", "msg-user-00000002");
    expect(plan).toMatchObject({ draft: "retry this", workspace: "C:/workspace", index: 2, snapshotIds: ["snap-new"] });
    expect(store.commitRewind(plan)).toBe(true);
    expect(store.getMessages("session").map(message => message.id)).toEqual([
      "msg-user-00000001",
      "msg-assistant-0001",
    ]);
    expect(store.commitRewind(plan)).toBe(false);
    expect(store.rollbackRewind(plan)).toBe(true);
    expect(store.getMessages("session").map(message => message.id)).toEqual([
      "msg-user-00000001",
      "msg-assistant-0001",
      "msg-user-00000002",
      "msg-assistant-0002",
    ]);
    expect(store.rollbackRewind(plan)).toBe(false);
  });

  it("persists one-shot approval decisions and rejects a consumed replay", () => {
    const store = new SessionStore({ runtimeDir: "." });
    store.upsertSession({ id: "session", title: "Approval" });
    store.appendMessage("session", {
      id: "msg-assistant-approval",
      role: "assistant",
      content: "",
      at: "2026-07-14T10:00:00.000Z",
      parts: [{
        type: "approval",
        approvalId: "approval-12345678",
        toolCallId: "call-1",
        name: "run_command",
        args: { command: "npm test" },
        reason: "permission_rule_requires_confirmation",
        status: "pending",
      }],
      modelMessages: [{
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "run_command", input: { command: "npm test" } },
          { type: "tool-approval-request", approvalId: "approval-12345678", toolCallId: "call-1", signature: "signed" },
        ],
      }],
      approvalModelParams: {
        effort: "high",
        contextWindowOverride: 96_000,
      },
    });

    const resolved = store.resolveApproval("session", "approval-12345678", {
      approved: true,
      reason: "Approved for this run",
      now: "2026-07-14T10:01:00.000Z",
    });
    expect(resolved.approval).toMatchObject({ status: "approved" });
    expect(resolved.approval.consumedAt).toBeUndefined();
    expect(resolved.ready).toBe(true);
    expect(resolved.modelParams).toEqual({ effort: "high", contextWindowOverride: 96_000 });

    const consumed = store.consumeApproval(
      "session",
      "approval-12345678",
      "2026-07-14T10:01:01.000Z",
    );
    expect(consumed).toMatchObject({ status: "approved", consumedAt: "2026-07-14T10:01:01.000Z" });
    expect(() => store.resolveApproval("session", "approval-12345678", {
      approved: true,
      now: "2026-07-14T10:02:00.000Z",
    })).toThrowError("approval_already_consumed");
  });

  it("fails an expired approval closed and keeps the session resumable", () => {
    const store = new SessionStore({ runtimeDir: "." });
    store.upsertSession({ id: "session", title: "Expired approval" });
    store.appendMessage("session", {
      id: "msg-assistant-expired",
      role: "assistant",
      content: "",
      at: "2026-07-14T10:00:00.000Z",
      parts: [{
        type: "approval",
        approvalId: "approval-expired-1",
        toolCallId: "call-expired-1",
        name: "run_command",
        status: "pending",
        expiresAt: "2026-07-14T10:01:00.000Z",
      }],
    });

    const resolved = store.resolveApproval("session", "approval-expired-1", {
      approved: true,
      now: "2026-07-14T10:02:00.000Z",
    });

    expect(resolved).toMatchObject({
      ready: true,
      approval: {
        status: "expired",
        decisionReason: "approval_expired",
        consumedAt: expect.any(String),
      },
    });
    expect(store.hasUnconsumedApprovals("session")).toBe(false);
    expect(store.consumeApproval("session", "approval-expired-1", "2026-07-14T10:02:01.000Z"))
      .toMatchObject({ status: "expired", consumedAt: "2026-07-14T10:02:00.000Z" });
    expect(store.hasUnconsumedApprovals("session")).toBe(false);
  });
});
