import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStores } from "../data/index.js";
import { reindexProjectMemory } from "./project-indexer.js";
import { createLtmBridge } from "./ltm-bridge.js";
import { createPlanStore } from "../orchestration/plan.js";
import { writeHandoff } from "./handoff.js";
import { openMemoryIndex, closeMemoryIndex } from "./index-backend.js";

describe("project memory indexer (Tier A → FTS projection)", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-indexer-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("projects MEMORY, plan, decisions, handoffs into MemoryStore and FTS-search finds them", async () => {
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "Prefer local durable SQLite memory", "utf8");

    const plan = createPlanStore(ws);
    await plan.writeRoadmap([
      { n: 1, title: "index projection", status: "in_progress", endState: "FTS live" },
    ]);
    await plan.writeState({ roadmapId: "r1", currentPhase: 1, updatedAt: "2026-01-01T00:00:00.000Z" });

    const bridge = createLtmBridge(join(ws, "ltm"));
    await bridge.addDecision({
      decision: "Files are source of truth for memory",
      rationale: "rebuildable index",
      tags: ["arch"],
      sessionId: "s1",
    });
    await bridge.refreshRuntimeSnapshot();

    await writeHandoff(ws, {
      id: "handoff_idx",
      createdAt: "2026-01-01T00:00:00.000Z",
      sessionId: "s1",
      trigger: "explicit",
      intent: "wire FTS projection",
      constraints: [],
      done: [],
      nextActions: [],
      keyFiles: [],
      decisions: [],
      openQuestions: [],
    });

    const stores = createStores(join(ws, ".kyrei", "index"));
    try {
      const result = await reindexProjectMemory({
        workspace: ws,
        memory: stores.memory,
        vectors: stores.vectors,
        ltmEnabled: true,
        planningEnabled: true,
      });
      expect(result.upserted).toBeGreaterThanOrEqual(4);
      expect(result.vectorsUpserted).toBeGreaterThanOrEqual(4);
      expect(result.sources).toEqual(expect.arrayContaining(["memory", "plan", "decision", "handoff"]));

      const hits = await stores.memory.search("SQLite");
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits.some((h) => h.body.includes("SQLite") || h.title?.includes("MEMORY"))).toBe(true);

      const decisionHits = await stores.memory.search("source of truth");
      expect(decisionHits.some((h) => h.kind === "decision")).toBe(true);

      const { embedText } = await import("./embed-adapter.js");
      const knn = await stores.vectors.query(await embedText("offline source of truth"), {
        k: 3,
        ownerType: "memory_doc",
      });
      expect(knn.length).toBeGreaterThanOrEqual(1);
    } finally {
      await stores.close();
    }
  });

  it("openMemoryIndex defaults to sqlite under .kyrei/index and can be disabled", async () => {
    const off = await openMemoryIndex(ws, { enabled: false });
    expect(off.stores).toBeNull();

    const on = await openMemoryIndex(ws, { backend: "sqlite" });
    expect(on.stores).not.toBeNull();
    expect(on.backend === "sqlite" || on.backend === "file").toBe(true);
    await closeMemoryIndex(on.stores);
  });

  it("projects string entryCandidates from project-index.json into graph-lite memory docs", async () => {
    await mkdir(join(ws, ".kyrei", "intel"), { recursive: true });
    await writeFile(
      join(ws, ".kyrei", "intel", "project-index.json"),
      JSON.stringify({
        version: 1,
        fileCount: 3,
        languages: { TypeScript: 3 },
        entryCandidates: ["src/index.ts", "package.json"],
      }),
      "utf8",
    );

    const stores = createStores(join(ws, ".kyrei", "index"));
    try {
      const result = await reindexProjectMemory({
        workspace: ws,
        memory: stores.memory,
        ltmEnabled: false,
        planningEnabled: false,
      });
      expect(result.sources).toContain("graph");
      const doc = await stores.memory.getDoc("proj:intel:entry-candidates");
      expect(doc?.body).toContain("src/index.ts");
      expect(doc?.body).toContain("package.json");
      expect(doc?.body).not.toMatch(/- \?/);
    } finally {
      await stores.close();
    }
  });

  it("prunes Tier-A documents and vectors whose source disappeared", async () => {
    const memoryDir = join(ws, ".kyrei", "memory");
    await mkdir(memoryDir, { recursive: true });
    const memoryPath = join(memoryDir, "MEMORY.md");
    await writeFile(memoryPath, "obsolete durable memory token", "utf8");

    const stores = createStores(join(ws, ".kyrei", "index"));
    try {
      await reindexProjectMemory({
        workspace: ws,
        memory: stores.memory,
        vectors: stores.vectors,
        ltmEnabled: false,
        planningEnabled: false,
      });
      expect(await stores.memory.getDoc("proj:memory:MEMORY.md")).not.toBeNull();

      await rm(memoryPath);
      const rebuilt = await reindexProjectMemory({
        workspace: ws,
        memory: stores.memory,
        vectors: stores.vectors,
        ltmEnabled: false,
        planningEnabled: false,
      });

      expect(rebuilt.pruned).toBe(1);
      expect(await stores.memory.getDoc("proj:memory:MEMORY.md")).toBeNull();
      expect(await stores.memory.search("obsolete durable memory token")).toEqual([]);
      const vectorHits = await stores.vectors.query(new Float32Array(256), {
        k: 20,
        ownerType: "memory_doc",
      });
      expect(vectorHits.some((hit) => hit.ownerId === "proj:memory:MEMORY.md")).toBe(false);
    } finally {
      await stores.close();
    }
  });

  it("chunks long documents and replaces stale vectors on content changes", async () => {
    const memoryDir = join(ws, ".kyrei", "memory");
    await mkdir(memoryDir, { recursive: true });
    const memoryPath = join(memoryDir, "MEMORY.md");
    await writeFile(
      memoryPath,
      `${"durable architecture context ".repeat(240)}\nTAIL_VECTOR_TOKEN`,
      "utf8",
    );

    const stores = createStores(join(ws, ".kyrei", "index"));
    try {
      await reindexProjectMemory({
        workspace: ws,
        memory: stores.memory,
        vectors: stores.vectors,
        ltmEnabled: false,
        planningEnabled: false,
      });
      const first = await stores.vectors.query(new Float32Array(256), {
        k: 100,
        ownerType: "memory_doc",
      });
      expect(first.filter((hit) => hit.ownerId === "proj:memory:MEMORY.md").length).toBeGreaterThan(1);

      await writeFile(memoryPath, "replacement vector body", "utf8");
      await reindexProjectMemory({
        workspace: ws,
        memory: stores.memory,
        vectors: stores.vectors,
        ltmEnabled: false,
        planningEnabled: false,
      });
      const second = await stores.vectors.query(new Float32Array(256), {
        k: 100,
        ownerType: "memory_doc",
      });
      expect(second.filter((hit) => hit.ownerId === "proj:memory:MEMORY.md")).toHaveLength(1);
    } finally {
      await stores.close();
    }
  });
});
