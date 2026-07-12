import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: { port: number; token: string; close(): void };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-provider-"));
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

describe("gateway provider registry", () => {
  it("requires a per-launch capability and rejects another browser origin", async () => {
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/api/config`);
    expect(unauthorized.status).toBe(401);

    const crossOrigin = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
      headers: { "X-Kyrei-Gateway-Token": server.token, Origin: "https://attacker.example" },
    });
    expect(crossOrigin.status).toBe(403);

    const desktopOrigin = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
      headers: { "X-Kyrei-Gateway-Token": server.token, Origin: "null" },
    });
    expect(desktopOrigin.status).toBe(200);
    expect(desktopOrigin.headers.get("access-control-allow-origin")).toBe("null");
  });

  it("migrates to a registry and never returns provider secrets", async () => {
    const initial = await request<{ providers: unknown[] }>("/api/config");
    expect(initial.providers).toHaveLength(1);

    const created = await request<{ providers: Array<{ id: string; name: string }>; activeProviderId: string }>("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          name: "Local two",
          baseURL: "http://127.0.0.1:1234/v1",
          models: [{ id: "shared" }],
          requiresApiKey: false,
        },
      }),
    });
    expect(created.providers).toHaveLength(2);
    const local = created.providers.find((provider) => provider.name === "Local two")!;
    expect(created.activeProviderId).toBe(local.id);

    const configured = await request<{ providers: unknown[] }>(`/api/providers/${encodeURIComponent(local.id)}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "super-secret-value" }),
    });
    expect(JSON.stringify(configured)).not.toContain("super-secret-value");

    const deleted = await request<{ providers: unknown[] }>(`/api/providers/${encodeURIComponent(local.id)}`, { method: "DELETE" });
    expect(deleted.providers).toHaveLength(1);
  });
});
