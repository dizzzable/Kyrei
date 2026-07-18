import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: { port: number; token: string; close(): void | Promise<void> };
const providerDiscovery = vi.fn(async () => [{ id: "manual-model", name: "Manual model" }]);

const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, {
  ...init,
  headers: {
    "Content-Type": "application/json",
    "X-Kyrei-Gateway-Token": server.token,
    ...(init.headers ?? {}),
  },
});

beforeEach(async () => {
  providerDiscovery.mockClear();
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-provider-runtime-"));
  server = await startGateway({ dataDir, preferredPort: 0, providerDiscovery });
  const created = await request("/api/providers", {
    method: "POST",
    body: JSON.stringify({
      provider: {
        id: "self-hosted-ip",
        name: "Self hosted IP",
        protocol: "openai-chat",
        baseURL: "http://93.184.216.34:8080/v1",
        models: [{ id: "manual-model", name: "Manual model" }],
        enabled: true,
        allowInsecureHttp: true,
        requiresApiKey: false,
      },
      activate: false,
    }),
  });
  expect(created.status).toBe(201);
});

afterEach(async () => {
  await server?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("custom provider runtime boundary", () => {
  it("passes only the saved exact insecure origin into discovery", async () => {
    const response = await request("/api/providers/self-hosted-ip/discover", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    expect(providerDiscovery).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "self-hosted-ip",
      baseURL: "http://93.184.216.34:8080/v1",
      allowInsecureHttpOrigins: ["http://93.184.216.34:8080"],
    }));
  });

  it("resets ephemeral health without mutating saved profile or manual models", async () => {
    const before = await (await request("/api/config")).json() as { providers: unknown[] };
    const reset = await request("/api/providers/self-hosted-ip/runtime/reset", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ ok: true, scope: "provider" });
    const after = await (await request("/api/config")).json() as { providers: unknown[] };
    expect(after.providers).toEqual(before.providers);
  });
});
