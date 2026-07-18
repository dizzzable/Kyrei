import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryDoc, MemoryStore } from "../data/ports.js";

import { buildMemoryAtlas, memoryAtlasToGraphV1 } from "./atlas-view";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function memoryStore(project: MemoryDoc[], sessions: MemoryDoc[]): MemoryStore {
  return {
    async upsertDoc() {},
    async getDoc() { return null; },
    listDocs: vi.fn(async (filter?: { scope?: string }) => filter?.scope === "session" ? sessions : project),
    async search() { return []; },
    async removeDoc() {},
  };
}

describe("buildMemoryAtlas", () => {
  it("projects project/session memory and the complete Skill catalog into a stable tree", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-atlas-"));
    roots.push(workspace);
    await mkdir(join(workspace, ".kyrei", "intel"), { recursive: true });
    await writeFile(join(workspace, ".kyrei", "intel", "project-index.json"), JSON.stringify({
      version: 1,
      generatedAt: "2026-07-18T00:00:00.000Z",
      workspace,
      fileCount: 1,
      truncated: false,
      languages: { TypeScript: 1 },
      topLevel: ["src"],
      entryCandidates: ["src/main.ts"],
      nodes: [{ path: "src/main.ts", language: "TypeScript" }],
      edges: [],
    }), "utf8");

    const memory = memoryStore([{
      id: "doc-1",
      scope: "project",
      kind: "memory",
      path: ".kyrei/memory/imports/docs/architecture.md",
      title: "Architecture",
      body: "src/main.ts is the entry point",
      sourceRef: "tier-a:imported-doc",
      contentHash: "doc-hash",
      updatedAt: "2026-07-18T00:00:00.000Z",
    }], [{
      id: "session-1",
      scope: "session",
      kind: "memory",
      path: "sessions/session-1.md",
      title: "Session one",
      body: "Implemented the entry point",
      sourceRef: "session:session-1",
      contentHash: "session-hash",
      updatedAt: "2026-07-18T00:00:01.000Z",
    }]);

    const atlas = await buildMemoryAtlas({
      workspace,
      memory,
      skills: [{
        id: "workspace/testing",
        name: "testing",
        description: "Run project tests",
        path: ".agents/skills/testing/SKILL.md",
        rootKind: "workspace",
        enabled: true,
        compatible: true,
        digest: "skill-hash",
      }],
      evolution: [{
        id: "candidate-1",
        title: "Improve testing guidance",
        summary: "Proposal only",
        status: "pending",
        risk: "low",
        targetKind: "skill",
        targetId: "testing",
        updatedAt: "2026-07-18T10:00:00.000Z",
      }],
    });

    expect(memory.listDocs).toHaveBeenCalledWith({ scope: "project" });
    expect(memory.listDocs).toHaveBeenCalledWith({ scope: "session" });
    expect(atlas.nodes.some((node) => node.kind === "session" && node.title === "Session one")).toBe(true);
    expect(atlas.nodes.some((node) => node.kind === "skill" && node.title === "testing" && node.preview === "Run project tests")).toBe(true);
    expect(atlas.nodes.some((node) => node.kind === "evolution" && node.title === "Improve testing guidance")).toBe(true);
    expect(atlas.tree.some((node) => node.id === "tree:documents:imports:docs")).toBe(true);
    expect(atlas.tree.some((node) => node.id === "tree:skills:workspace")).toBe(true);
    expect(atlas.tree.some((node) => node.id === "tree:evolution:pending:skill")).toBe(true);
    expect(atlas.stats.evolution).toBe(1);
    expect(JSON.stringify(atlas)).not.toContain("SKILL.md body");
  });

  it("isolates an optional source failure and preserves exact degraded status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-atlas-degraded-"));
    roots.push(workspace);
    const atlas = await buildMemoryAtlas({
      workspace,
      optionalSources: [{
        descriptor: { id: "gbrain", label: "GBrain", capability: "search-only" },
        load: async () => { throw new Error("connection refused"); },
      }],
    });

    expect(atlas.sources.find((source) => source.id === "gbrain")).toMatchObject({
      capability: "search-only",
      health: "unavailable",
      reason: "source_load_failed",
    });
    expect(atlas.nodes.some((node) => node.kind === "project")).toBe(true);
  });

  it("adapts v2 back to the v1 graph contract", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-atlas-v1-"));
    roots.push(workspace);
    const atlas = await buildMemoryAtlas({ workspace });
    const graph = memoryAtlasToGraphV1(atlas);

    expect(graph.version).toBe(1);
    expect(graph.workspace).toBe(atlas.workspace);
    expect(graph.nodes.some((node) => node.id === "project:root")).toBe(true);
  });
});
