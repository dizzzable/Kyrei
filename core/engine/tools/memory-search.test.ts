import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemorySearchTools } from "./memory-search.js";
import { createLtmBridge } from "../memory/ltm-bridge.js";
import { createPlanStore } from "../orchestration/plan.js";
import { writeHandoff } from "../memory/handoff.js";
import { createStores } from "../data/index.js";
import { reindexProjectMemory } from "../memory/project-indexer.js";

async function exec(tools: ReturnType<typeof buildMemorySearchTools>, input: unknown): Promise<string> {
  const t = tools["memory_search"] as { execute: (input: unknown, opts: unknown) => Promise<string> };
  return t.execute(input, { toolCallId: "t1", messages: [] });
}

describe("memory_search", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-memsearch-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("finds hits across decisions, plan, MEMORY, and handoffs", async () => {
    const ltmDir = join(ws, "ltm");
    const bridge = createLtmBridge(ltmDir);
    await bridge.addDecision({
      decision: "Use SQLite for the local graph",
      rationale: "offline first",
      tags: ["arch"],
      sessionId: "s1",
    });
    await bridge.refreshRuntimeSnapshot();

    const plan = createPlanStore(ws);
    await plan.writeRoadmap([
      { n: 1, title: "wire memory contract", status: "in_progress", endState: "tools live" },
    ]);
    await plan.writeState({ roadmapId: "r1", currentPhase: 1, updatedAt: "2026-01-01T00:00:00.000Z" });

    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "Project prefers local durable memory", "utf8");
    await writeHandoff(ws, {
      id: "handoff_x",
      createdAt: "2026-01-01T00:00:00.000Z",
      sessionId: "s1",
      trigger: "explicit",
      intent: "finish memory glue",
      constraints: [],
      done: [],
      nextActions: ["tests"],
      keyFiles: [],
      decisions: [],
      openQuestions: [],
    });

    const tools = buildMemorySearchTools({
      workspace: ws,
      ltmDir,
      ltmEnabled: true,
      planningEnabled: true,
    });
    const out = await exec(tools, { query: "memory SQLite" });
    expect(out).toContain("memory_search");
    expect(out).toMatch(/decision|plan|memory|handoff/i);
    expect(out).toContain("SQLite");
  });

  it("returns a clear empty result", async () => {
    const tools = buildMemorySearchTools({ workspace: ws, ltmEnabled: false, planningEnabled: false });
    const out = await exec(tools, { query: "nothing-here-xyz" });
    expect(out).toContain("No hits");
  });

  it("searches live session snippets without an index", async () => {
    const tools = buildMemorySearchTools({
      workspace: ws,
      ltmEnabled: false,
      planningEnabled: false,
      sessionSnippets: [
        { role: "user", text: "We chose better-sqlite3 for local FTS" },
        { role: "assistant", text: "Acknowledged." },
      ],
    });
    const out = await exec(tools, { query: "better-sqlite3" });
    expect(out).toContain("live session");
    expect(out).toContain("better-sqlite3");
  });

  it("merges FTS + lexical-vector hits when stores are provided", async () => {
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "pgvector optional team bus only", "utf8");
    const stores = createStores(join(ws, ".kyrei", "index"));
    try {
      await reindexProjectMemory({
        workspace: ws,
        memory: stores.memory,
        vectors: stores.vectors,
        ltmEnabled: false,
        planningEnabled: false,
      });
      const tools = buildMemorySearchTools({
        workspace: ws,
        ltmEnabled: false,
        planningEnabled: false,
        memoryStore: stores.memory,
        vectorStore: stores.vectors,
        indexBackend: "sqlite",
      });
      const out = await exec(tools, { query: "pgvector" });
      expect(out).toContain("Index backend: sqlite");
      expect(out).toMatch(/FTS|lexical-vector/);
      expect(out).toMatch(/pgvector|MEMORY/i);
    } finally {
      await stores.close();
    }
  });

  it("searches dual-write session-mirror FTS when sessionStore is provided", async () => {
    const mirrorDir = join(ws, "session-mirror");
    const stores = createStores(mirrorDir);
    try {
      await stores.sessions.createSession({
        id: "chat-1",
        startedAt: new Date().toISOString(),
        status: "complete",
        jsonlPath: "gateway://chat-1",
        workspace: ws,
      });
      await stores.sessions.appendMessage({
        sessionId: "chat-1",
        seq: 1,
        role: "user",
        parts: [{ type: "text", text: "we decided on unique_mirror_fts_token for dual-write" }],
        text: "we decided on unique_mirror_fts_token for dual-write",
        createdAt: new Date().toISOString(),
      });
      const tools = buildMemorySearchTools({
        workspace: ws,
        ltmEnabled: false,
        planningEnabled: false,
        sessionStore: stores.sessions,
      });
      const out = await exec(tools, { query: "unique_mirror_fts_token" });
      expect(out).toMatch(/mirror|session/i);
      expect(out).toContain("unique_mirror_fts_token");
    } finally {
      await stores.close();
    }
  });
});
