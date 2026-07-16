import { describe, it, expect } from "vitest";
import {
  engineSessionToGateway,
  engineMessageToGateway,
  mergeSessionsPreferEngine,
  preferMessagesForPrimary,
} from "../core/session-engine-primary.js";

describe("session-engine-primary mapping", () => {
  it("maps engine session to gateway shape", () => {
    const g = engineSessionToGateway({
      id: "s1",
      title: "Hello",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      providerId: "p",
      modelId: "m",
      providerAccountId: "a",
      meta: { updatedAt: "2026-01-02T00:00:00.000Z" },
      jsonlPath: "x",
    });
    expect(g).toMatchObject({
      id: "s1",
      title: "Hello",
      providerId: "p",
      modelId: "m",
      providerAccountId: "a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      source: "engine-mirror",
    });
  });

  it("maps engine message including approval meta", () => {
    const m = engineMessageToGateway(
      {
        sessionId: "s1",
        seq: 2,
        role: "assistant",
        parts: [{ type: "approval", approvalId: "ap", toolCallId: "tc", name: "x", reason: "ask", status: "pending" }],
        text: "need",
        createdAt: "2026-01-01T00:00:00.000Z",
        clientId: "msg-hello12",
        pending: true,
        turnStatus: "awaiting_approval",
        approvalModelParams: { effort: "low" },
      },
      "s1",
    );
    expect(m.id).toBe("msg-hello12");
    expect(m.pending).toBe(true);
    expect(m.turnStatus).toBe("awaiting_approval");
    expect(m.approvalModelParams).toEqual({ effort: "low" });
    expect(m.parts[0].type).toBe("approval");
  });

  it("merges sessions preferring engine fields", () => {
    const merged = mergeSessionsPreferEngine(
      [{ id: "a", title: "Json", providerId: "old", updatedAt: "2026-01-01T00:00:00.000Z" }],
      [{ id: "a", title: "", providerId: "new", modelId: "m", updatedAt: "2026-01-02T00:00:00.000Z" },
       { id: "b", title: "Only engine", updatedAt: "2026-01-03T00:00:00.000Z" }],
    );
    expect(merged.map((s) => s.id)).toEqual(["b", "a"]);
    expect(merged.find((s) => s.id === "a")).toMatchObject({
      title: "Json",
      providerId: "new",
      modelId: "m",
    });
  });

  it("prefers engine messages only when caught up", () => {
    const json = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const engShort = [{ id: "1" }];
    const engFull = [{ id: "1" }, { id: "2" }, { id: "3" }];
    expect(preferMessagesForPrimary(json, engShort).source).toBe("json");
    expect(preferMessagesForPrimary(json, engFull).source).toBe("engine");
    expect(preferMessagesForPrimary(json, []).source).toBe("json");
  });

  it("generates stable clientId when engine message lacks one", () => {
    const m = engineMessageToGateway(
      {
        sessionId: "sess-x",
        seq: 7,
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        text: "hi",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      "sess-x",
    );
    expect(m.id).toMatch(/^msg-engine-sess-x-7$/);
  });
});
