import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

type GatewayServer = { port: number; token: string; close(): void | Promise<void> };
type SyncStatus = {
  state: "ready" | "disabled" | "error";
  sessionCount: number;
  sync?: {
    state: "idle" | "running" | "completed" | "failed";
    totalSessions: number;
    completedSessions: number;
    resumable: boolean;
  };
};

let dataDir = "";
let server: GatewayServer | null = null;

const sessionsFixture = (count: number) => ({
  schemaVersion: 7,
  sessions: Array.from({ length: count }, (_, index) => ({
    id: `mirror-${String(index + 1).padStart(4, "0")}`,
    title: `Mirror ${index + 1}`,
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    status: "idle",
  })),
  messages: Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const id = `mirror-${String(index + 1).padStart(4, "0")}`;
    return [id, [{ id: `msg-${id}`, role: "user", text: `message ${index + 1}`, at: "2026-07-18T00:00:00.000Z" }]];
  })),
  mission: null,
  updatedAt: "2026-07-18T00:00:00.000Z",
});

async function startWithSessions(count: number, engineLoader?: Parameters<typeof startGateway>[0]["engineLoader"]) {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-mirror-sync-"));
  await writeFile(join(dataDir, "state.json"), `${JSON.stringify(sessionsFixture(count), null, 2)}\n`, "utf8");
  server = await startGateway({
    dataDir,
    preferredPort: 0,
    engineLoader: engineLoader ?? (async () => import("../core/engine/.dist/index.mjs")),
  });
}

async function request(path: string, init: RequestInit = {}) {
  if (!server) throw new Error("gateway_not_started");
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Kyrei-Gateway-Token": server.token,
      ...(init.headers ?? {}),
    },
  });
}

async function waitForCompleted() {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await request("/api/memory/session-mirror");
    const status = await response.json() as SyncStatus;
    if (status.sync?.state === "completed") return status;
    if (status.sync?.state === "failed") throw new Error("mirror_sync_failed");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
  }
  throw new Error("mirror_sync_timeout");
}

afterEach(async () => {
  await server?.close();
  server = null;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = "";
});

describe("resumable session mirror synchronization", () => {
  it("persists its cursor during shutdown and resumes the remaining JSON sessions on the next gateway boot", async () => {
    let unblockFirstSync: (() => void) | null = null;
    let signalFirstSync: (() => void) | null = null;
    const firstSyncStarted = new Promise<void>((resolve) => { signalFirstSync = resolve; });
    const firstSyncUnblocked = new Promise<void>((resolve) => { unblockFirstSync = resolve; });
    let blockNextSync = true;
    await startWithSessions(3, async () => {
      const engine = await import("../core/engine/.dist/index.mjs");
      return {
        ...engine,
        createSessionMirror: (options: Parameters<typeof engine.createSessionMirror>[0]) => {
          const mirror = engine.createSessionMirror(options);
          return {
            ...mirror,
            syncSession: async (...args: Parameters<typeof mirror.syncSession>) => {
              if (blockNextSync) {
                blockNextSync = false;
                signalFirstSync?.();
                await firstSyncUnblocked;
              }
              return mirror.syncSession(...args);
            },
          };
        },
      };
    });

    const started = await request("/api/memory/session-mirror/sync", { method: "POST" });
    expect(started.status).toBe(202);
    await firstSyncStarted;

    const closing = server!.close();
    unblockFirstSync?.();
    await closing;
    server = null;

    const interrupted = JSON.parse(await readFile(join(dataDir, "session-mirror-sync.json"), "utf8")) as {
      state: string;
      nextIndex: number;
    };
    expect(interrupted).toMatchObject({ state: "running", nextIndex: 1 });

    server = await startGateway({
      dataDir,
      preferredPort: 0,
      engineLoader: async () => import("../core/engine/.dist/index.mjs"),
    });
    const completed = await waitForCompleted();
    expect(completed.sessionCount).toBe(3);
    expect(completed.sync).toMatchObject({ state: "completed", completedSessions: 3, totalSessions: 3 });

    const parity = await request("/api/memory/session-mirror/parity");
    const parityBody = await parity.json() as { missingInMirror: string[] };
    expect(parityBody.missingInMirror).toEqual([]);
  });

  it("reports every mirrored session instead of silently capping status at 500", async () => {
    await startWithSessions(501);
    const accepted = await request("/api/memory/session-mirror/sync", { method: "POST" });
    expect(accepted.status).toBe(202);

    const completed = await waitForCompleted();
    expect(completed.sessionCount).toBe(501);
    expect(completed.sync).toMatchObject({ state: "completed", completedSessions: 501, totalSessions: 501 });
  });
});
