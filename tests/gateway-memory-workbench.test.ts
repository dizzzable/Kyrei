import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

let dataDir = "";
let workspace = "";
let server: { port: number; token: string; close(): void | Promise<void> };

const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, {
  ...init,
  headers: {
    "Content-Type": "application/json",
    "X-Kyrei-Gateway-Token": server.token,
    ...(init.headers ?? {}),
  },
});

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-memory-workbench-"));
  workspace = join(dataDir, "workspace");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src", "main.ts"), "import './queue.js';\n", "utf8");
  await writeFile(join(workspace, "src", "queue.ts"), "export const queue = true;\n", "utf8");
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: async () => import("../core/engine/.dist/index.mjs"),
  });
  await request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ workspace }),
  });
});

afterEach(async () => {
  await server?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("memory workbench gateway", () => {
  it("imports documentation, indexes it, and exposes it in the memory graph", async () => {
    const response = await request("/api/memory/documents/import", {
      method: "POST",
      body: JSON.stringify({
        files: [{
          fileName: "queue-guide.md",
          contentBase64: Buffer.from("# Queue guide\n\nQueue retries are bounded.").toString("base64"),
        }],
      }),
    });
    const imported = await response.json() as {
      imported: Array<{ relativePath: string }>;
      reindex: { ok: boolean };
    };
    expect(response.status).toBe(200);
    expect(imported.imported[0]?.relativePath).toContain(".kyrei/memory/imports/");
    expect(imported.reindex.ok).toBe(true);

    const graphResponse = await request("/api/memory/graph");
    const graph = await graphResponse.json() as {
      nodes: Array<{ group: string; title: string; path?: string }>;
      edges: Array<{ type: string }>;
    };
    expect(graphResponse.status).toBe(200);
    expect(graph.nodes.some((node) => node.group === "document" && node.title.includes("queue-guide"))).toBe(true);
    expect(graph.nodes.some((node) => node.group === "code" && node.path === "src/main.ts")).toBe(true);
    expect(graph.edges.length).toBeGreaterThan(0);
  });

  it("rejects unsupported document types without writing them", async () => {
    const response = await request("/api/memory/documents/import", {
      method: "POST",
      body: JSON.stringify({
        files: [{ fileName: "archive.zip", contentBase64: Buffer.from("nope").toString("base64") }],
      }),
    });
    const body = await response.json() as { rejected: Array<{ code: string }> };
    expect(response.status).toBe(422);
    expect(body.rejected[0]?.code).toBe("document_type_unsupported");
  });
});
