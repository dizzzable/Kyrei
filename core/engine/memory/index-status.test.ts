import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWorkspaceMemoryIndex, reindexWorkspaceMemoryIndex } from "./index-status.js";

describe("memory index status + reindex", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "kyrei-idx-status-"));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it("reports disabled when backend is off", async () => {
    const status = await inspectWorkspaceMemoryIndex({
      workspace: ws,
      config: { enabled: false, backend: "off" },
    });
    expect(status.state).toBe("disabled");
  });

  it("reindexes tier-A files and reports ready doc counts", async () => {
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "status test durable fact", "utf8");
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
    expect(result.status.tierA.memoryMd).toBe(true);
  });

  it("treats Windows slash variants as the same workspace identity", async () => {
    await mkdir(join(ws, ".kyrei", "memory"), { recursive: true });
    await writeFile(join(ws, ".kyrei", "memory", "MEMORY.md"), "canonical workspace fact", "utf8");
    const first = await reindexWorkspaceMemoryIndex({
      workspace: ws,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
    });
    const alternate = process.platform === "win32" ? ws.replaceAll("\\", "/") : ws;
    const second = await reindexWorkspaceMemoryIndex({
      workspace: alternate,
      config: { enabled: true, backend: "sqlite" },
      ltmEnabled: false,
      planningEnabled: false,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.status.docCount).toBe(first.status.docCount);
  });
});
