import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: { port: number; token: string; close(): void | Promise<void> };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-import-gw-"));
  const workspace = join(dataDir, "workspace");
  await mkdir(workspace, { recursive: true });
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: async () => import("../core/engine/.dist/index.mjs"),
  });
  // configure workspace via config API
  await fetch(`http://127.0.0.1:${server.port}/api/config`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Kyrei-Gateway-Token": server.token,
    },
    body: JSON.stringify({
      workspace,
      providers: [{
        id: "test-local",
        name: "Test",
        protocol: "openai-chat",
        baseURL: "http://127.0.0.1:9/v1",
        requiresApiKey: false,
        enabled: true,
        models: [{ id: "m", name: "m" }],
      }],
      activeProviderId: "test-local",
      activeModelId: "m",
    }),
  });
});

afterEach(async () => {
  await server?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("POST /api/import/transcript", () => {
  it("imports kyrei export fixture into handoff + seed session", async () => {
    const fixture = readFileSync(
      join(process.cwd(), "tests/fixtures/session-import/kyrei-export.min.json"),
    );
    const contentBase64 = fixture.toString("base64");
    const response = await fetch(`http://127.0.0.1:${server.port}/api/import/transcript`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kyrei-Gateway-Token": server.token,
      },
      body: JSON.stringify({
        fileName: "kyrei-export.min.json",
        contentBase64,
        options: { createSession: true, writeLtm: false },
      }),
    });
    const body = await response.json() as {
      report: {
        adapterId: string;
        messageCount: number;
        handoffPath?: string;
        sessionId?: string;
      };
      sessionId?: string;
    };
    expect(response.status).toBe(200);
    expect(body.report.adapterId).toBe("kyrei-export");
    expect(body.report.messageCount).toBeGreaterThan(0);
    expect(body.report.handoffPath).toBeTruthy();
    expect(body.sessionId || body.report.sessionId).toBeTruthy();

    const handoff = await readFile(body.report.handoffPath!, "utf8");
    expect(handoff.length).toBeGreaterThan(20);

    const sessions = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      headers: { "X-Kyrei-Gateway-Token": server.token },
    }).then((r) => r.json()) as { sessions: Array<{ id: string; source?: string; title?: string }> };
    const seeded = sessions.sessions.find((s) => s.id === (body.sessionId || body.report.sessionId));
    expect(seeded).toBeTruthy();
    expect(seeded?.source === "import" || String(seeded?.title ?? "").includes("import")).toBe(true);

    await server.close();
    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => import("../core/engine/.dist/index.mjs"),
    });
    const afterRestart = await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      headers: { "X-Kyrei-Gateway-Token": server.token },
    }).then((result) => result.json()) as { sessions: Array<{ id: string }> };
    expect(afterRestart.sessions.some((session) => session.id === (body.sessionId || body.report.sessionId))).toBe(true);
  });

  it("rejects oversized payload", async () => {
    const huge = Buffer.alloc(33 * 1024 * 1024, 0x61);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/import/transcript`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kyrei-Gateway-Token": server.token,
      },
      body: JSON.stringify({
        fileName: "huge.txt",
        contentBase64: huge.toString("base64"),
      }),
    });
    expect(response.status).toBe(413);
  });
});
