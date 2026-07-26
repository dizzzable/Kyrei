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

  it("links an evolution candidate to its skill target when the node exists", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-atlas-evo-edge-"));
    roots.push(workspace);
    const atlas = await buildMemoryAtlas({
      workspace,
      memory: memoryStore([], []),
      skills: [{
        id: "workspace/testing",
        name: "testing",
        rootKind: "workspace",
        enabled: true,
        compatible: true,
      }],
      evolution: [
        // targetId matches the skill node id → a references edge is added.
        { id: "cand-linked", title: "Tune testing", status: "approved", risk: "low", targetKind: "skill", targetId: "workspace/testing" },
        // targetId has no matching node → no target edge (silently skipped).
        { id: "cand-orphan", title: "Orphan", status: "pending", risk: "low", targetKind: "skill", targetId: "does-not-exist" },
        // Non-skill target kind → never linked.
        { id: "cand-profile", title: "Profile", status: "pending", risk: "low", targetKind: "prompt-profile", targetId: "kyrei-main" },
      ],
    });

    const evoEdges = atlas.edges.filter((edge) => edge.source === "evolution:cand-linked" && edge.type === "references");
    expect(evoEdges).toEqual([{ source: "evolution:cand-linked", target: "skill:workspace/testing", type: "references", sourceId: "evolution" }]);
    expect(atlas.edges.some((edge) => edge.source === "evolution:cand-orphan" && edge.type === "references")).toBe(false);
    expect(atlas.edges.some((edge) => edge.source === "evolution:cand-profile" && edge.type === "references")).toBe(false);
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

  describe("semantic related edges", () => {
    /** Two docs about the same subject plus one that shares nothing with them. */
    const relatedDocs = (): MemoryDoc[] => ([
      {
        id: "pool-1", scope: "project", kind: "memory", path: ".kyrei/memory/notes/pool-1.md",
        title: "Connection pool exhaustion",
        body: "Every worker process instantiates its own independent connection pool at startup, so the ceiling on simultaneous backend connections is the pool size multiplied by the worker count, and sustained traffic pushes it past the configured server maximum.",
        sourceRef: "tier-a:note", contentHash: "h1", updatedAt: "2026-07-18T00:00:00.000Z",
      },
      {
        id: "pool-2", scope: "project", kind: "memory", path: ".kyrei/memory/notes/pool-2.md",
        title: "Pool exhaustion fix",
        body: "We capped the per worker connection pool so pool size times worker count stays beneath the configured server maximum, and intend to add a multiplexing proxy so idle client sessions stop holding backend connections open.",
        sourceRef: "tier-a:note", contentHash: "h2", updatedAt: "2026-07-18T00:00:00.000Z",
      },
      {
        id: "pasta", scope: "project", kind: "memory", path: ".kyrei/memory/notes/pasta.md",
        title: "Weeknight pasta",
        body: "Salt the boiling water aggressively, warm olive oil in a wide pan with thinly sliced garlic and dried chilli flakes, then reserve a mug of the starchy cooking water before draining the spaghetti.",
        sourceRef: "tier-a:note", contentHash: "h3", updatedAt: "2026-07-18T00:00:00.000Z",
      },
    ]);

    it("links docs that share a subject and leaves unrelated ones alone", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "kyrei-atlas-related-"));
      roots.push(workspace);
      const atlas = await buildMemoryAtlas({ workspace, memory: memoryStore(relatedDocs(), []) });

      const related = atlas.edges.filter((edge) => edge.type === "related");
      expect(related).toEqual([{ source: "memory:pool-1", target: "memory:pool-2", type: "related", sourceId: "memory" }]);
    });

    it("omits related edges when the caller opts out", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "kyrei-atlas-related-off-"));
      roots.push(workspace);
      const atlas = await buildMemoryAtlas({ workspace, memory: memoryStore(relatedDocs(), []), relatedEdges: false });

      expect(atlas.edges.some((edge) => edge.type === "related")).toBe(false);
    });

    it("never spends the structural edge budget or reports truncation for related edges", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "kyrei-atlas-related-budget-"));
      roots.push(workspace);
      // `edgeLimit` has a floor of 100, so the budget boundary is only
      // reachable with enough docs to produce that many structural edges.
      const base = relatedDocs();
      const docs: MemoryDoc[] = Array.from({ length: 120 }, (_, i) => {
        const source = base[i % base.length]!;
        return { ...source, id: `${source.id}-${i}`, path: `.kyrei/memory/notes/${source.id}-${i}.md`, contentHash: `h-${i}` };
      });

      const structuralOnly = await buildMemoryAtlas({ workspace, memory: memoryStore(docs, []), relatedEdges: false });
      const structuralCount = structuralOnly.edges.length;
      expect(structuralCount).toBeGreaterThan(100);

      // Budget exactly consumed by structural edges → related edges get none,
      // and must not displace a structural edge or fake a truncation reason.
      const exact = await buildMemoryAtlas({ workspace, memory: memoryStore(docs, []), maxEdges: structuralCount });
      expect(exact.edges).toEqual(structuralOnly.edges);
      expect(exact.edges.some((edge) => edge.type === "related")).toBe(false);
      expect(exact.stats.truncationReasons.some((reason) => reason.startsWith("edges:"))).toBe(false);

      // A little headroom → related edges appear, but only up to that headroom.
      const roomy = await buildMemoryAtlas({ workspace, memory: memoryStore(docs, []), maxEdges: structuralCount + 5 });
      const related = roomy.edges.filter((edge) => edge.type === "related");
      expect(related.length).toBeGreaterThan(0);
      expect(related.length).toBeLessThanOrEqual(5);
      expect(roomy.edges.length).toBeLessThanOrEqual(structuralCount + 5);
      expect(roomy.stats.truncationReasons.some((reason) => reason.startsWith("edges:"))).toBe(false);
    });

    it("strips related edges from the v1 projection", async () => {
      const workspace = await mkdtemp(join(tmpdir(), "kyrei-atlas-related-v1-"));
      roots.push(workspace);
      const atlas = await buildMemoryAtlas({ workspace, memory: memoryStore(relatedDocs(), []) });
      expect(atlas.edges.some((edge) => edge.type === "related")).toBe(true);

      const graph = memoryAtlasToGraphV1(atlas);
      expect(graph.edges.some((edge) => (edge as { type: string }).type === "related")).toBe(false);
    });
  });

  describe("containment", () => {
    async function workspaceWithCode(files: string[], imports: Array<{ from: string; to: string }> = []): Promise<string> {
      const workspace = await mkdtemp(join(tmpdir(), "kyrei-atlas-contains-"));
      roots.push(workspace);
      await mkdir(join(workspace, ".kyrei", "intel"), { recursive: true });
      await writeFile(join(workspace, ".kyrei", "intel", "project-index.json"), JSON.stringify({
        version: 1,
        generatedAt: "2026-07-18T00:00:00.000Z",
        workspace,
        fileCount: files.length,
        truncated: false,
        languages: { TypeScript: files.length },
        // Deliberately only ONE entry candidate: under the rule this replaces,
        // a code file was connected only if it was an entry point or an import
        // target, which left the rest of the index unreachable.
        entryCandidates: ["src/main.ts"],
        nodes: files.map((path) => ({ path, language: "TypeScript" })),
        edges: imports,
      }), "utf8");
      return workspace;
    }

    it("leaves no node without a path back to the workspace root", async () => {
      // The defect this guards: 426 of 696 code files had no edge at all, so a
      // quarter of the graph rendered as unattached dots and the directory
      // structure was invisible.
      const workspace = await workspaceWithCode([
        "src/main.ts", "src/lib/deep/nested/util.ts", "core/engine/index.ts", "standalone.ts",
      ]);
      const atlas = await buildMemoryAtlas({ workspace, memory: memoryStore([{
        id: "doc-1", scope: "project", kind: "memory", path: ".kyrei/memory/notes.md",
        title: "Notes", body: "n", sourceRef: "tier-a:memory", contentHash: "h",
      }], []) });

      const parent = new Map<string, string>();
      for (const edge of atlas.edges) if (edge.type === "contains") parent.set(edge.target, edge.source);
      for (const node of atlas.nodes) {
        if (node.id === "project:root") continue;
        let current: string | undefined = node.id;
        const seen = new Set<string>();
        while (current && current !== "project:root" && !seen.has(current)) {
          seen.add(current);
          current = parent.get(current);
        }
        expect(current, `${node.id} has no path to the root`).toBe("project:root");
      }
    });

    it("nests a file under each of its real directories", async () => {
      const workspace = await workspaceWithCode(["src/lib/deep/util.ts"]);
      const atlas = await buildMemoryAtlas({ workspace, memory: memoryStore([], []) });

      const byId = new Map(atlas.nodes.map((node) => [node.id, node]));
      const parent = new Map<string, string>();
      for (const edge of atlas.edges) if (edge.type === "contains") parent.set(edge.target, edge.source);
      const chain: string[] = [];
      let current: string | undefined = "code:src/lib/deep/util.ts";
      while (current) {
        chain.unshift(byId.get(current)?.title ?? current);
        current = parent.get(current);
      }
      expect(chain.slice(1)).toEqual(["Code", "src", "lib", "deep", "util.ts"]);
    });

    it("gives every folder the region of what it holds", async () => {
      const workspace = await workspaceWithCode(["src/main.ts"]);
      const atlas = await buildMemoryAtlas({ workspace, memory: memoryStore([], [{
        id: "session-1", scope: "session", kind: "memory", path: "session/s-1/msg-1",
        title: "Chat", body: "b", sourceRef: "session:s-1", contentHash: "h",
      }]) });

      const folders = atlas.nodes.filter((node) => node.kind === "folder");
      expect(folders.length).toBeGreaterThan(0);
      expect(new Set(folders.map((node) => node.sourceId))).toEqual(new Set(["code", "sessions"]));
    });

    it("agrees with the tree about which category a node belongs to", async () => {
      // These disagreed: a memory-derived `document` claimed sourceId "memory"
      // while living under the Documents root, so no node anywhere carried the
      // "documents" id its own edges referenced.
      const workspace = await workspaceWithCode(["src/main.ts"]);
      const atlas = await buildMemoryAtlas({ workspace, memory: memoryStore([{
        id: "doc-1", scope: "project", kind: "memory", path: ".kyrei/memory/imports/guide.md",
        title: "Guide", body: "b", sourceRef: "tier-a:imported-doc", contentHash: "h",
      }], []) });

      const byNodeId = new Map(atlas.tree.filter((row) => row.nodeId).map((row) => [row.nodeId!, row]));
      for (const node of atlas.nodes) {
        const row = byNodeId.get(node.id);
        if (row) expect(node.sourceId, node.id).toBe(row.sourceId);
      }
      expect(atlas.nodes.find((node) => node.id === "memory:doc-1")?.sourceId).toBe("documents");
    });

    it("spends the budget on the skeleton before any overlay", async () => {
      const files = Array.from({ length: 120 }, (_, i) => `src/mod${i}/file.ts`);
      const imports = files.slice(1).map((path) => ({ from: files[0]!, to: path }));
      const workspace = await workspaceWithCode(files, imports);
      const atlas = await buildMemoryAtlas({ workspace, memory: memoryStore([], []), maxEdges: 100 });

      expect(atlas.edges.length).toBeLessThanOrEqual(100);
      // Containment fills the budget first: an import is worth less than the
      // directory edge that gives a file a place to be at all.
      expect(atlas.edges.every((edge) => edge.type === "contains")).toBe(true);
      // A dropped structural edge is reported, never dropped in silence — the
      // rule this replaces cut 19 of them without a word.
      expect(atlas.stats.truncationReasons.some((reason) => reason.startsWith("edges:"))).toBe(true);
    });
  });
});
