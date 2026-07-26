import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";
import { resolveEngineConfig } from "../core/engine/config/schema.js";

type GatewayServer = { port: number; token: string; close(): Promise<void> | void };
type ConfigResponse = {
  engine?: Record<string, unknown>;
  engineConfigRejections?: Array<{ path: string; message: string }>;
};

let dataDir = "";
let workspace = "";
let server: GatewayServer | null = null;

async function startWith(engine: Record<string, unknown>, opts: { withEngine?: boolean } = {}) {
  await writeFile(
    join(dataDir, "kyrei-config.json"),
    `${JSON.stringify({ workspace, engine }, null, 2)}\n`,
    "utf8",
  );
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    // The real validator, reached through the same `mod.resolveEngineConfig`
    // seam the production bundle exposes — so this pins the wiring, not a mock.
    engineLoader: async () => (opts.withEngine === false
      ? { listModels: () => [] }
      : { listModels: () => [], resolveEngineConfig }),
  });
  const response = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
    headers: { "X-Kyrei-Gateway-Token": server.token },
  });
  return await response.json() as ConfigResponse;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-rejections-"));
  workspace = await mkdtemp(join(tmpdir(), "kyrei-workspace-rejections-"));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    /* ignore close races */
  }
  server = null;
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
});

describe("GET /api/config exposes refused engine settings", () => {
  it("reports a refused leaf with its path", async () => {
    // Clearing the connection string in Settings writes "", which fails
    // `z.string().min(1)`. The engine then runs on the default, and the only
    // signal used to be a console.warn in the main process.
    const body = await startWith({ memory: { index: { enabled: true, connectionString: "" } } });

    expect(body.engineConfigRejections).toEqual([
      { path: "memory.index.connectionString", message: expect.any(String) },
    ]);
    // The stored value is still echoed back — that is exactly why the UI has to
    // say it is not in force.
    expect((body.engine?.memory as { index: { connectionString: string } }).index.connectionString).toBe("");
  });

  it("reports nothing for a config the validator accepts", async () => {
    const body = await startWith({ maxSteps: 12 });
    expect(body.engineConfigRejections).toEqual([]);
  });

  it("does not report successful migrations as rejections", async () => {
    // `maxToolCalls` is a legacy alias: it is rewritten, and the value the user
    // set stays in force. Reporting it would train users to ignore the banner.
    const body = await startWith({ maxToolCalls: 9 });
    expect(body.engineConfigRejections).toEqual([]);
  });

  it("still serves the config when the engine bundle cannot validate it", async () => {
    const body = await startWith({ memory: { index: { connectionString: "" } } }, { withEngine: false });
    expect(body.engineConfigRejections).toEqual([]);
    expect(body.engine).toBeDefined();
  });
});

describe("DELETE /api/sessions/:id cleans up derived artifacts", () => {
  it("drops the session's rolling context summary", async () => {
    // Nothing ever called clearContextSummary, so every session that was ever
    // compressed left a file in the workspace forever.
    await startWith({});
    const created = await fetch(`http://127.0.0.1:${server!.port}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kyrei-Gateway-Token": server!.token },
      body: "{}",
    });
    const session = await created.json() as { id: string };

    const dir = join(workspace, ".kyrei", "context-summary");
    await mkdir(dir, { recursive: true });
    const summary = join(dir, `${session.id}.json`);
    const survivor = join(dir, "another-session.json");
    await writeFile(summary, JSON.stringify({ sessionId: session.id, summaryText: "compressed" }), "utf8");
    await writeFile(survivor, JSON.stringify({ sessionId: "another-session", summaryText: "keep" }), "utf8");

    const removed = await fetch(`http://127.0.0.1:${server!.port}/api/sessions/${session.id}`, {
      method: "DELETE",
      headers: { "X-Kyrei-Gateway-Token": server!.token },
    });
    expect(removed.status).toBe(200);

    await expect(access(summary)).rejects.toBeTruthy();
    // Only this session's cache is dropped.
    await expect(access(survivor)).resolves.toBeUndefined();
  });
});
