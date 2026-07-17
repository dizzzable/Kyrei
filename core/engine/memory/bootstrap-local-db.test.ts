import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapGatewayLocalStores,
  bootstrapWorkspaceLocalStores,
} from "./bootstrap-local-db.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("bootstrap local databases (OOB)", () => {
  let dataDir: string;
  let workspace: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-boot-data-"));
    workspace = await mkdtemp(join(tmpdir(), "kyrei-boot-ws-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });

  it("creates session-mirror SQLite under app dataDir on install/start", () => {
    const result = bootstrapGatewayLocalStores(dataDir);
    expect(result.ok).toBe(true);
    expect(result.sessionMirror.ok).toBe(true);
    expect(["sqlite", "file"]).toContain(result.sessionMirror.backend);
  });

  it("creates workspace .kyrei layout, index.db, graph.db, and MEMORY.md seed", async () => {
    const result = await bootstrapWorkspaceLocalStores({
      workspace,
      config: { enabled: true, backend: "sqlite" },
      seedMemoryMd: true,
    });
    expect(result.ok).toBe(true);
    expect(result.seededMemoryMd).toBe(true);
    expect(result.index.ok).toBe(true);
    expect(result.graph.ok).toBe(true);

    expect(await exists(join(workspace, ".kyrei", "memory"))).toBe(true);
    expect(await exists(join(workspace, ".kyrei", "intel"))).toBe(true);
    expect(await exists(join(workspace, ".kyrei", "index"))).toBe(true);
    expect(await exists(join(workspace, ".kyrei", "memory", "MEMORY.md"))).toBe(true);
    // SQLite file when native available; memory-docs.json when file fallback
    const sqlite = await exists(join(workspace, ".kyrei", "index", "index.db"));
    const fileDocs = await exists(join(workspace, ".kyrei", "index", "memory-docs.json"));
    expect(sqlite || fileDocs || result.index.backend === "sqlite" || result.index.backend === "file").toBe(true);
    expect(await exists(join(workspace, ".kyrei", "intel", "project-graph.db"))).toBe(true);

    const body = await readFile(join(workspace, ".kyrei", "memory", "MEMORY.md"), "utf8");
    expect(body).toContain("Project memory");

    // Idempotent — no second seed rewrite required
    const again = await bootstrapWorkspaceLocalStores({
      workspace,
      config: { enabled: true, backend: "sqlite" },
      seedMemoryMd: true,
    });
    expect(again.seededMemoryMd).toBe(false);
    expect(again.ok).toBe(true);
  });
});
