import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStores } from "./index.js";
import { createSessionMirror } from "./session-mirror.js";

describe("session mirror dual-write", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kyrei-sess-mirror-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("mirrors sessions and messages into engine SessionStore FTS", async () => {
    const stores = createStores(dir);
    try {
      const mirror = createSessionMirror({
        sessions: stores.sessions,
        sensitiveValues: ["SUPERSECRET"],
      });
      await mirror.syncSession(
        { id: "s1", title: "Auth", workspace: "/ws", status: "active" },
        [
          { id: "m1", role: "user", text: "use SUPERSECRET and sk-abcdefghijklmnopqrstuvwxyz012345" },
          { id: "m2", role: "assistant", text: "noted JWT plan" },
        ],
      );
      const listed = await stores.sessions.listSessions({ workspace: "/ws" });
      expect(listed.some((s) => s.id === "s1")).toBe(true);
      const msgs = await stores.sessions.getMessages("s1");
      expect(msgs.length).toBe(2);
      expect(msgs[0]!.text).toContain("[REDACTED]");
      expect(msgs[0]!.text).not.toContain("SUPERSECRET");
      const hits = await stores.sessions.searchMessages("JWT");
      expect(hits.length).toBeGreaterThanOrEqual(1);
    } finally {
      await stores.close();
    }
  });

  it("replace-on-sync drops stale tail messages", async () => {
    const stores = createStores(dir);
    try {
      const mirror = createSessionMirror({ sessions: stores.sessions });
      await mirror.syncSession(
        { id: "s1", title: "T", status: "active" },
        [
          { role: "user", text: "one alpha" },
          { role: "assistant", text: "two beta" },
          { role: "user", text: "three gamma" },
        ],
      );
      expect((await stores.sessions.getMessages("s1")).length).toBe(3);

      await mirror.syncSession(
        { id: "s1", title: "T", status: "active" },
        [
          { role: "user", text: "short alpha only" },
        ],
      );
      const msgs = await stores.sessions.getMessages("s1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.text).toContain("short alpha");
      const stale = await stores.sessions.searchMessages("gamma");
      expect(stale).toHaveLength(0);
    } finally {
      await stores.close();
    }
  });

  it("removeSession drops mirror rows and FTS hits", async () => {
    const stores = createStores(dir);
    try {
      const mirror = createSessionMirror({ sessions: stores.sessions });
      await mirror.syncSession(
        { id: "gone", title: "Delete me", status: "complete" },
        [{ role: "user", text: "unique_mirror_delete_token" }],
      );
      expect((await stores.sessions.getSession("gone"))?.id).toBe("gone");
      await mirror.removeSession("gone");
      expect(await stores.sessions.getSession("gone")).toBeNull();
      expect(await stores.sessions.getMessages("gone")).toEqual([]);
      expect(await stores.sessions.searchMessages("unique_mirror_delete_token")).toHaveLength(0);
    } finally {
      await stores.close();
    }
  });

  it("mirrors provider binding and approval parts for cutover schema v2", async () => {
    const stores = createStores(dir);
    try {
      const mirror = createSessionMirror({ sessions: stores.sessions });
      await mirror.syncSession(
        {
          id: "s-cut",
          title: "Cutover",
          status: "working",
          providerId: "openai",
          modelId: "gpt-test",
          providerAccountId: "acct1",
        },
        [
          {
            id: "msg-abc12345",
            role: "assistant",
            text: "need approval",
            turnStatus: "awaiting_approval",
            pending: true,
            parts: [
              { type: "text", text: "need approval" },
              {
                type: "approval",
                approvalId: "appr-1-longid",
                toolCallId: "call-1-longid",
                name: "run_command",
                reason: "ask",
                status: "pending",
              },
            ],
            approvalModelParams: { effort: "low" },
          },
        ],
      );
      const session = await stores.sessions.getSession("s-cut");
      expect(session?.providerId).toBe("openai");
      expect(session?.modelId).toBe("gpt-test");
      expect(session?.providerAccountId).toBe("acct1");
      expect(session?.status).toBe("working");
      const msgs = await stores.sessions.getMessages("s-cut");
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.clientId).toBe("msg-abc12345");
      expect(msgs[0]!.pending).toBe(true);
      expect(msgs[0]!.turnStatus).toBe("awaiting_approval");
      expect(msgs[0]!.approvalModelParams).toEqual({ effort: "low" });
      expect(msgs[0]!.parts.some((p) => p.type === "approval" && p.status === "pending")).toBe(true);
    } finally {
      await stores.close();
    }
  });
});
