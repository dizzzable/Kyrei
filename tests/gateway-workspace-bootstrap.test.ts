/**
 * OOB: open project folder → local DBs exist without manual Rebuild.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../core/gateway.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("gateway workspace bootstrap OOB", () => {
  let dataDir = "";
  let workspace = "";
  let server: { port: number; token: string; close(): void | Promise<void> };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-ws-boot-data-"));
    workspace = await mkdtemp(join(tmpdir(), "kyrei-ws-boot-ws-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "main.ts"), "export const x = 1;\n", "utf8");
    server = await startGateway({ dataDir, preferredPort: 0 });
  });

  afterEach(async () => {
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      ...init,
      headers: {
        "X-Kyrei-Gateway-Token": server.token,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `${response.status}`);
    return body;
  }

  it("setConfig workspace creates .kyrei stores and memory index docs", async () => {
    await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ workspace }),
    });

    expect(await exists(join(workspace, ".kyrei", "memory", "MEMORY.md"))).toBe(true);
    expect(await exists(join(workspace, ".kyrei", "intel", "project-graph.db"))).toBe(true);
    const indexDb = await exists(join(workspace, ".kyrei", "index", "index.db"));
    const indexFile = await exists(join(workspace, ".kyrei", "index", "memory-docs.json"));
    expect(indexDb || indexFile).toBe(true);

    const status = await request<{
      state: string;
      docCount: number;
      tierA: { memoryMd: boolean };
    }>("/api/memory/index");
    expect(status.state).toBe("ready");
    expect(status.tierA.memoryMd).toBe(true);
    expect(status.docCount).toBeGreaterThanOrEqual(1);
  });
});
