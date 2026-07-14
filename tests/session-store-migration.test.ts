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

    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.sessions).toEqual([
      { id: "empty-ru", title: "" },
      { id: "empty-en", title: "" },
      { id: "used", title: "New session" },
      { id: "custom", title: "My session" },
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
      { id: "valid", title: "Chat", providerId: "provider", modelId: "model", providerAccountId: "backup-1" },
      { id: "invalid", title: "Chat" },
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
});
