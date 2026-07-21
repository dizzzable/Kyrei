import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";
import { PROMPT_VERSION } from "../core/engine/prompt/system.js";

let dataDir = "";
let server: { port: number; token: string; close(): void | Promise<void> } | null = null;

async function request(path: string) {
  if (!server) throw new Error("gateway_not_started");
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    headers: { "X-Kyrei-Gateway-Token": server.token },
  });
}

afterEach(async () => {
  await server?.close();
  server = null;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = "";
});

describe("effective prompt inspector", () => {
  it("returns the versioned local baseline and truthfully lists turn-specific omissions", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-effective-prompt-"));
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => import("../core/engine/.dist/index.mjs"),
    });

    const response = await request("/api/prompt/effective");
    const body = await response.json() as {
      kind: string;
      version: string;
      stable: string;
      chars: number;
      availableTools: string[];
      omissions: string[];
    };

    expect(response.status).toBe(200);
    expect(body.kind).toBe("baseline");
    expect(body.version).toBe(PROMPT_VERSION);
    expect(body.stable).toContain("You are Kyrei");
    expect(body.chars).toBeGreaterThan(1_000);
    expect(body.availableTools).toContain("read_file");
    expect(body.omissions).toEqual(expect.arrayContaining([
      "project_context_and_recall",
      "current_session_messages",
      "per_turn_skill_selection",
      "team_role_assignment",
      "runtime_tool_health",
    ]));
  });
});
