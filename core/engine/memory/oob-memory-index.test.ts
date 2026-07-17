/**
 * Focused OOB checklist for project indexing → durable memory projection.
 * Catches the regressions that unit isolation previously missed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectIndexIncremental, persistProjectIndex } from "../intel/project-index.js";
import { reindexWorkspaceMemoryIndex } from "./index-status.js";
import {
  MemoryIndexSession,
  flushMemoryIndexPoolForTests,
} from "./index-session.js";
import { createFileStores } from "../data/index.js";
import { buildProjectIntelTools } from "../tools/project-intel.js";

describe("OOB memory/index checklist", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-oob-idx-"));
    await flushMemoryIndexPoolForTests();
  });
  afterEach(async () => {
    await flushMemoryIndexPoolForTests();
    await rm(ws, { recursive: true, force: true });
  });

  it("1) Rebuild index writes durable docs (MEMORY → FTS projection)", async () => {
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "OOB durable fact alpha-unique-42", "utf8");

    const result = await reindexWorkspaceMemoryIndex({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
    });
    expect(result.ok).toBe(true);
    expect(result.upserted).toBeGreaterThanOrEqual(1);
    expect(result.status.state).toBe("ready");
    expect(result.status.docCount).toBeGreaterThanOrEqual(1);

    // Second inspect (new connection) still sees docs — not an ephemeral Map.
    const again = await reindexWorkspaceMemoryIndex({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
    });
    expect(again.status.docCount).toBeGreaterThanOrEqual(1);
  });

  it("2) project_index → graph-lite searchable after awaited flush", async () => {
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "index.ts"), 'export const boot = "oob";\n', "utf8");
    await writeFile(join(ws, "package.json"), '{"name":"oob-idx"}\n', "utf8");

    const session = await MemoryIndexSession.acquire({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
    });
    try {
      // First acquire is dirty — warm index once so subsequent flush is mutation-driven.
      await session.reindexNow();

      let flushed = 0;
      const tools = buildProjectIntelTools(ws, {
        flushMemoryIndex: async () => {
          flushed += 1;
          session.notifyMutated();
          await session.reindexNow();
        },
      });
      const execute = (tools.project_index as { execute: () => Promise<string> }).execute;
      const text = await execute();
      expect(text).toMatch(/project intelligence|Files:/i);
      expect(flushed).toBe(1);

      const intel = await readFile(join(ws, ".kyrei", "intel", "project-index.json"), "utf8");
      expect(intel).toContain("package.json");
      expect(intel).toContain("src/index.ts");

      const graph = await session.memoryStore!.getDoc("proj:intel:entry-candidates");
      expect(graph?.body).toMatch(/package\.json|src\/index\.ts/);
      expect(graph?.body).not.toMatch(/- \?$/m);

      const hits = await session.memoryStore!.search("package");
      expect(hits.some((h) => h.id === "proj:intel:entry-candidates" || h.body.includes("package"))).toBe(true);
    } finally {
      await session.release();
      await flushMemoryIndexPoolForTests();
    }
  });

  it("3) second reindexNow without dirty does not thrash (clean pool)", async () => {
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "stable", "utf8");
    const session = await MemoryIndexSession.acquire({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
    });
    await session.reindexNow();
    const n1 = (await session.memoryStore!.listDocs({ workspace: ws })).length;
    await session.reindexNow();
    const n2 = (await session.memoryStore!.listDocs({ workspace: ws })).length;
    expect(n2).toBe(n1);
    await session.release();
  });

  it("4) file backend survives reopen (SQLite-unavailable path)", async () => {
    const dir = join(ws, ".kyrei", "index-file");
    const a = createFileStores(dir);
    await a.memory.upsertDoc({
      id: "oob-file-1",
      scope: "project",
      kind: "memory",
      path: "MEMORY.md",
      workspace: ws,
      title: "m",
      body: "file backend OOB",
      contentHash: "x",
      updatedAt: new Date().toISOString(),
    });
    await a.close();
    const b = createFileStores(dir);
    expect((await b.memory.getDoc("oob-file-1"))?.body).toContain("file backend OOB");
    await b.close();
  });

  it("5) incremental project index persists JSON for later reindex", async () => {
    await mkdir(join(ws, "src"), { recursive: true });
    await writeFile(join(ws, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const index = await buildProjectIndexIncremental(ws);
    await persistProjectIndex(ws, index);
    const raw = JSON.parse(await readFile(join(ws, ".kyrei", "intel", "project-index.json"), "utf8")) as {
      entryCandidates?: string[];
      fileCount?: number;
    };
    expect(raw.fileCount).toBeGreaterThanOrEqual(1);

    const result = await reindexWorkspaceMemoryIndex({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
    });
    expect(result.ok).toBe(true);
    expect(result.sources).toContain("graph");
  });
});
