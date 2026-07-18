import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildContinuationPacket,
  readContinuationPacket,
  renderContinuationContext,
  writeContinuationPacket,
} from "../core/session-continuation.js";
import { SessionStore } from "../core/session-store.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kyrei-continuation-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("continuation checkpoint", () => {
  it("persists a bounded, redacted packet with only completed local mutation receipts", async () => {
    const packet = buildContinuationPacket({
      continuationSessionId: "sess-next",
      sourceSessionId: "sess-parent",
      sensitiveValues: ["top-secret-token"],
      contextSummary: {
        summaryText: "Older work used top-secret-token and still needs verification.",
        via: "heuristic",
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
      messages: [
        { role: "user", text: "Implement the continuation flow" },
        {
          role: "assistant",
          text: "Implemented the storage layer.",
          parts: [
            {
              type: "tool",
              name: "write_file",
              args: { path: "src/continuation.ts" },
              result: "written",
              running: false,
            },
            {
              type: "tool",
              name: "edit_file",
              args: { patch: [{ file: "src/blocked.ts" }] },
              error: "permission denied",
              running: false,
            },
            {
              type: "tool",
              name: "write_file",
              args: { path: "src/pending.ts" },
              running: false,
              awaitingApproval: true,
            },
          ],
        },
      ],
    });

    expect(packet.verifiedMutations).toEqual([{ tool: "write_file", path: "src/continuation.ts" }]);
    expect(packet.failedTools).toEqual([{ tool: "edit_file", error: "permission denied" }]);
    expect(packet.rollingSummary).not.toContain("top-secret-token");

    await writeContinuationPacket(dir, packet);
    const stored = await readContinuationPacket(dir, "sess-next");
    expect(stored?.sourceSessionId).toBe("sess-parent");
    const context = renderContinuationContext(stored, ["top-secret-token"]);
    expect(context).toContain("SESSION_CONTINUATION_REFERENCE");
    expect(context).toContain("src/continuation.ts");
    expect(context).not.toContain("src/pending.ts");
    expect(context).not.toContain("top-secret-token");
  });

  it("creates a clean child that retains provider, model, and task lineage", async () => {
    const store = new SessionStore({ runtimeDir: dir });
    await store.load();
    store.upsertSession({
      id: "sess-parent",
      title: "Long task",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      providerId: "provider",
      modelId: "model",
      codingMode: "build",
    });
    for (let index = 0; index < 501; index += 1) {
      store.appendMessage("sess-parent", { role: "user", text: `message ${index}` });
    }

    const result = store.createContinuation("sess-parent");
    expect(store.getMessages("sess-parent")).toHaveLength(501);
    expect(store.getMessages(result!.session.id)).toEqual([]);
    expect(result!.session).toMatchObject({
      parentSessionId: "sess-parent",
      rootSessionId: "sess-parent",
      lineageKind: "continuation",
      continuationSourceSessionId: "sess-parent",
      continuationPacketVersion: 1,
      providerId: "provider",
      modelId: "model",
      codingMode: "build",
    });
  });
});
