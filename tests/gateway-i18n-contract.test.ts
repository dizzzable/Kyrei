import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: { port: number; token: string; close(): void };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-i18n-"));
  server = await startGateway({ dataDir, preferredPort: 0 });
});

afterEach(async () => {
  server.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: { "X-Kyrei-Gateway-Token": server.token, ...(init?.headers ?? {}) },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status}`);
  return body;
}

describe("gateway localization boundary", () => {
  it("stores a locale-neutral title for a new session", async () => {
    const { id } = await request<{ id: string }>("/api/sessions", { method: "POST" });
    const { sessions } = await request<{ sessions: Array<{ id: string; title?: string }> }>("/api/sessions");

    expect(sessions.find(session => session.id === id)?.title).toBe("");
  });
});
