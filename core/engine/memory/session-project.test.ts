import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStores } from "../data/index.js";
import {
  projectSessionsIntoMemory,
  snippetsFromModelMessages,
  flattenMessageParts,
  messageText,
} from "./session-project.js";

describe("session projection", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-sess-proj-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("projects session messages into MemoryStore FTS", async () => {
    const stores = createStores(join(ws, ".kyrei", "index"));
    try {
      const result = await projectSessionsIntoMemory(
        [
          {
            id: "s1",
            title: "Auth work",
            messages: [
              { id: "msg-1", role: "user", text: "Implement JWT auth for the API" },
              { id: "msg-2", role: "assistant", text: "I'll add middleware and tests." },
            ],
          },
        ],
        { workspace: ws, memory: stores.memory, vectors: stores.vectors },
      );
      expect(result.upserted).toBe(2);
      const hits = await stores.memory.search("JWT auth");
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits.some((h) => h.path?.includes("session/s1"))).toBe(true);
    } finally {
      await stores.close();
    }
  });

  it("redacts secrets and exact sensitive values before indexing", async () => {
    const stores = createStores(join(ws, ".kyrei", "index"));
    try {
      await projectSessionsIntoMemory(
        [
          {
            id: "s-secret",
            messages: [
              {
                id: "m1",
                role: "user",
                text: "key is sk-abcdefghijklmnopqrstuvwxyz012345 and custom SUPERSECRETVALUE",
              },
            ],
          },
        ],
        {
          workspace: ws,
          memory: stores.memory,
          sensitiveValues: ["SUPERSECRETVALUE"],
        },
      );
      const hits = await stores.memory.search("key");
      const body = hits.map((h) => h.body).join("\n");
      expect(body).toContain("[REDACTED]");
      expect(body).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
      expect(body).not.toContain("SUPERSECRETVALUE");
    } finally {
      await stores.close();
    }
  });

  it("prunes stale projections when a message disappears", async () => {
    const stores = createStores(join(ws, ".kyrei", "index"));
    try {
      await projectSessionsIntoMemory(
        [
          {
            id: "s2",
            messages: [
              { id: "keep", role: "user", text: "alpha topic" },
              { id: "drop", role: "user", text: "beta unique-token-xyz" },
            ],
          },
        ],
        { workspace: ws, memory: stores.memory, pruneStale: true },
      );
      expect((await stores.memory.search("unique-token-xyz")).length).toBeGreaterThanOrEqual(1);

      await projectSessionsIntoMemory(
        [
          {
            id: "s2",
            messages: [{ id: "keep", role: "user", text: "alpha topic only" }],
          },
        ],
        { workspace: ws, memory: stores.memory, pruneStale: true },
      );
      expect((await stores.memory.search("unique-token-xyz")).length).toBe(0);
      expect((await stores.memory.search("alpha")).length).toBeGreaterThanOrEqual(1);
    } finally {
      await stores.close();
    }
  });

  it("flattens parts including tool breadcrumbs", () => {
    expect(
      flattenMessageParts([
        { type: "text", text: "hello" },
        { type: "tool", name: "read_file", result: "file body content here" },
      ]),
    ).toContain("hello");
    expect(
      messageText({
        parts: [{ type: "text", text: "from parts" }],
      }),
    ).toBe("from parts");
  });

  it("extracts and redacts live snippets from model messages", () => {
    const snippets = snippetsFromModelMessages(
      [
        { role: "user", content: "remember sk-abcdefghijklmnopqrstuvwxyz012345" },
        { role: "assistant", content: [{ type: "text", text: "noted in LTM" }] },
        { role: "tool", content: "skip" },
      ],
      { sensitiveValues: [] },
    );
    expect(snippets).toHaveLength(2);
    expect(snippets[0]!.text).toContain("[REDACTED]");
    expect(snippets[1]!.text).toContain("LTM");
  });
});
