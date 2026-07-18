import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryDoc, MemoryStore } from "../data/ports.js";

import { buildWorkspaceMemoryGraph } from "./graph-view.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function memoryStore(docs: MemoryDoc[]): MemoryStore {
  return {
    async upsertDoc() {},
    async getDoc() { return null; },
    async listDocs() { return docs; },
    async search() { return []; },
    async removeDoc() {},
  };
}

describe("buildWorkspaceMemoryGraph", () => {
  it("combines deterministic code edges with memory-document nodes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "kyrei-memory-graph-"));
    roots.push(workspace);
    await mkdir(join(workspace, ".kyrei", "intel"), { recursive: true });
    await writeFile(join(workspace, ".kyrei", "intel", "project-index.json"), JSON.stringify({
      version: 1,
      generatedAt: "2026-07-18T00:00:00.000Z",
      workspace,
      fileCount: 2,
      truncated: false,
      languages: { TypeScript: 2 },
      topLevel: ["src"],
      entryCandidates: ["src/main.ts"],
      nodes: [
        { path: "src/main.ts", language: "TypeScript" },
        { path: "src/lib.ts", language: "TypeScript" },
      ],
      edges: [{ from: "src/main.ts", to: "src/lib.ts", type: "imports", provenance: "EXTRACTED" }],
    }), "utf8");

    const graph = await buildWorkspaceMemoryGraph({
      workspace,
      memory: memoryStore([{
        id: "proj:imported:architecture.md",
        scope: "project",
        kind: "memory",
        path: ".kyrei/memory/imports/architecture.md",
        title: "Architecture",
        body: "The entry point is src/main.ts.",
        sourceRef: "tier-a:imported-doc",
        contentHash: "hash",
        updatedAt: "2026-07-18T00:00:00.000Z",
      }]),
    });

    expect(graph.nodes.some((node) => node.group === "code" && node.path === "src/main.ts")).toBe(true);
    expect(graph.nodes.some((node) => node.group === "document" && node.title === "Architecture")).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "imports")).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "references")).toBe(true);
  });
});
