import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

type GatewayServer = { port: number; token: string; close(): Promise<void> | void };

let dataDir = "";
let server: GatewayServer | null = null;

const AGENT_ID = "agent-resume-contract";

/**
 * Seed a non-terminal checkpoint so the gateway recovers a run at startup.
 * `recoverRecoverable` keys files by sha256 of the agent id and skips any run
 * whose last row is terminal.
 */
async function seedCheckpoint(state: string) {
  const dir = join(dataDir, "agent-runs");
  await mkdir(dir, { recursive: true });
  const row = {
    agentId: AGENT_ID,
    state,
    goal: "finish the migration",
    createdAt: new Date().toISOString(),
    checkpointManifest: { completedSteps: 2, totalSteps: 5 },
  };
  await writeFile(
    join(dir, `${createHash("sha256").update(AGENT_ID).digest("hex")}.jsonl`),
    `${JSON.stringify(row)}\n`,
    "utf8",
  );
}

async function post(path: string) {
  if (!server) throw new Error("test gateway is not running");
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Kyrei-Gateway-Token": server.token },
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-agent-resume-"));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    /* ignore close races */
  }
  server = null;
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe("POST /api/agents/:id/resume", () => {
  it("refuses with a machine-readable pointer to the supported recovery path", async () => {
    // Resume-from-checkpoint is deliberately NOT implemented: the manifest is
    // persisted but no runtime consumes it to skip completed work. `/retry`
    // re-runs on the session, which retains full context, and is the supported
    // path. This test pins the contract a client depends on to say so — the
    // fields below are the only way a caller learns retry is an option.
    await seedCheckpoint("running");
    server = await startGateway({ dataDir, preferredPort: 0 });

    const { status, body } = await post(`/api/agents/${AGENT_ID}/resume`);

    expect(status).toBe(409);
    expect(body.code).toBe("agent_resume_unavailable");
    expect(body.hint).toBe("use_retry");
    expect(typeof body.recoverable).toBe("boolean");
    // The persisted manifest is passed through so a client can show progress
    // even though nothing can act on it yet.
    expect(body.checkpoint_manifest).toBeTruthy();
  });

  it("reports an unknown agent as not found rather than unavailable", async () => {
    server = await startGateway({ dataDir, preferredPort: 0 });

    const { status, body } = await post("/api/agents/no-such-agent/resume");

    expect(status).toBe(404);
    expect(body.code).toBe("agent_not_found");
  });

  it("rejects a malformed agent id before looking anything up", async () => {
    server = await startGateway({ dataDir, preferredPort: 0 });

    const { status, body } = await post(`/api/agents/${encodeURIComponent("   ")}/resume`);

    expect(status).toBe(400);
    expect(body.code).toBe("agent_id_invalid");
  });
});
