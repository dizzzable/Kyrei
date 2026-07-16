import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../core/session-store.js";

describe("session fork lineage", () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kyrei-fork-"));
    store = new SessionStore({ runtimeDir: dir });
    await store.load();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("forks full history with lineage fields and leaves parent intact", () => {
    store.upsertSession({
      id: "sess-parent",
      title: "Main",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      providerId: "p1",
      modelId: "m1",
    });
    store.appendMessage("sess-parent", { role: "user", content: "one", text: "one" });
    store.appendMessage("sess-parent", { role: "assistant", content: "a1", text: "a1" });
    store.appendMessage("sess-parent", { role: "user", content: "two", text: "two" });

    const parentMsgsBefore = store.getMessages("sess-parent").map((m) => m.id);
    const forked = store.forkSession("sess-parent");
    expect(forked).toBeTruthy();
    expect(forked!.session.parentSessionId).toBe("sess-parent");
    expect(forked!.session.rootSessionId).toBe("sess-parent");
    expect(forked!.session.lineageKind).toBe("branch");
    expect(forked!.session.title).toBe("Main");
    expect(forked!.messageCount).toBe(3);
    expect(store.getMessages("sess-parent").map((m) => m.id)).toEqual(parentMsgsBefore);
    expect(store.getMessages(forked!.session.id)).toHaveLength(3);
    // New message ids
    for (const id of store.getMessages(forked!.session.id).map((m) => m.id)) {
      expect(parentMsgsBefore).not.toContain(id);
    }
  });

  it("forks from a user message prefix only", () => {
    store.upsertSession({
      id: "sess-p",
      title: "T",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const u1 = store.appendMessage("sess-p", { role: "user", content: "first", text: "first" });
    store.appendMessage("sess-p", { role: "assistant", content: "reply", text: "reply" });
    store.appendMessage("sess-p", { role: "user", content: "second", text: "second" });

    const forked = store.forkSession("sess-p", { messageId: u1.id });
    expect(forked!.messageCount).toBe(1);
    expect(forked!.session.forkedFromMessageId).toBe(u1.id);
    const texts = store.getMessages(forked!.session.id).map((m) => m.text || m.content);
    expect(texts).toEqual(["first"]);
    expect(store.getMessages("sess-p")).toHaveLength(3);
  });

  it("rejects fork from non-user message", () => {
    store.upsertSession({
      id: "sess-p",
      title: "T",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.appendMessage("sess-p", { role: "user", content: "u", text: "u" });
    const a = store.appendMessage("sess-p", { role: "assistant", content: "a", text: "a" });
    expect(() => store.forkSession("sess-p", { messageId: a.id })).toThrow(/fork_message_not_user/);
  });

  it("strips pending approvals on fork", () => {
    store.upsertSession({
      id: "sess-ap",
      title: "A",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.appendMessage("sess-ap", {
      role: "assistant",
      content: "need approval",
      text: "need approval",
      parts: [
        {
          type: "approval",
          approvalId: "appr-1",
          status: "pending",
          toolName: "run_command",
        },
      ],
    });
    const forked = store.forkSession("sess-ap")!;
    const child = store.getMessages(forked.session.id)[0];
    const approval = (child.parts as Array<{ type?: string; status?: string; deniedReason?: string }>)
      ?.find((p) => p.type === "approval");
    expect(approval?.status).toBe("denied");
    expect(approval?.deniedReason).toBe("forked_session");
    expect(child.pending).toBe(false);
  });

  it("archive parent does not remove child", () => {
    store.upsertSession({
      id: "sess-p",
      title: "P",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.appendMessage("sess-p", { role: "user", content: "hi", text: "hi" });
    const child = store.forkSession("sess-p")!.session;
    store.setSessionArchived("sess-p", true);
    expect(store.getSession("sess-p")?.archived).toBe(true);
    expect(store.getSession(child.id)?.archived).toBe(false);
    expect(store.listActiveSessions().some((s) => s.id === child.id)).toBe(true);
  });
});
