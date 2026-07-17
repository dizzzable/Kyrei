import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryIndexSession,
  flushMemoryIndexPoolForTests,
  memoryIndexPoolSizeForTests,
} from "./index-session.js";

describe("MemoryIndexSession pool", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-idx-sess-"));
    await flushMemoryIndexPoolForTests();
  });
  afterEach(async () => {
    await flushMemoryIndexPoolForTests();
    await rm(ws, { recursive: true, force: true });
  });

  it("shares one backend across concurrent acquires and reindexes docs", async () => {
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "pooled index hybrid search", "utf8");

    const a = await MemoryIndexSession.acquire({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
    });
    const b = await MemoryIndexSession.acquire({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
    });
    expect(memoryIndexPoolSizeForTests()).toBe(1);
    await a.reindexNow();
    expect(a.memoryStore).toBeDefined();
    const hits = await a.memoryStore!.search("hybrid");
    expect(hits.length).toBeGreaterThanOrEqual(1);

    await a.release();
    // Still pooled while b holds a ref
    expect(memoryIndexPoolSizeForTests()).toBe(1);
    await b.release();
  });

  it("notifyMutated eventually reindexes after a write", async () => {
    const session = await MemoryIndexSession.acquire({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      planningEnabled: false,
      ltmEnabled: false,
    });
    await session.reindexNow();
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "mid-turn mutation signal xyzzy", "utf8");
    session.notifyMutated();
    // debounce 300ms + work
    await new Promise((r) => setTimeout(r, 500));
    const hits = await session.memoryStore!.search("xyzzy");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    await session.release();
  });

  it("skips full reindex when the pool entry is clean (no dirty flag)", async () => {
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "once only projection", "utf8");

    const session = await MemoryIndexSession.acquire({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
    });
    await session.reindexNow();
    const first = await session.memoryStore!.listDocs({ workspace: ws });
    expect(first.length).toBeGreaterThanOrEqual(1);

    // Clean second call must not thrash — still returns cached docs.
    await session.reindexNow();
    const second = await session.memoryStore!.listDocs({ workspace: ws });
    expect(second.length).toBe(first.length);
    await session.release();
  });

  it("reindexes when the pooled vault projection config changes", async () => {
    const vault = join(ws, "vault");
    await mkdir(vault, { recursive: true });
    await writeFile(join(vault, "note.md"), "pooled vault lifecycle fact", "utf8");
    const enabledVault = {
      enabled: true,
      paths: [vault],
      maxFiles: 50,
      maxFileChars: 4_000,
      maxDepth: 4,
    };
    const first = await MemoryIndexSession.acquire({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
      vault: enabledVault,
    });
    await first.reindexNow();
    expect((await first.memoryStore!.listDocs({ scope: "project" })).some((d) => d.sourceRef === "vault:markdown")).toBe(true);
    await first.release();

    const second = await MemoryIndexSession.acquire({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
      vault: { ...enabledVault, enabled: false, paths: [] },
    });
    await second.reindexNow();
    expect((await second.memoryStore!.listDocs({ scope: "project" })).some((d) => d.sourceRef === "vault:markdown")).toBe(false);
    await second.release();
  });
});
