import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  it("imports a complete public provider registry without importing secrets", async () => {
    const imported = await request<{ activeProviderId: string; activeModelId: string; providers: Array<{ id: string; hasKey: boolean }> }>("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: [
          { id: "local", name: "Local", protocol: "openai-chat", baseURL: "http://127.0.0.1:11434/v1", models: [{ id: "llama" }], requiresApiKey: false },
          { id: "gemini", name: "Gemini", protocol: "google-generative-ai", baseURL: "https://generativelanguage.googleapis.com/v1beta", models: [{ id: "gemini-2.5-pro" }], requiresApiKey: true },
        ],
        activeProviderId: "gemini",
        activeModelId: "gemini-2.5-pro",
      }),
    });
    expect(imported.activeProviderId).toBe("gemini");
    expect(imported.activeModelId).toBe("gemini-2.5-pro");
    expect(imported.providers).toHaveLength(2);
    expect(imported.providers.find((provider) => provider.id === "gemini")?.hasKey).toBe(false);
  });

  it("clears stored credentials when a profile moves to another origin", async () => {
    const created = await request<{ activeProviderId: string; providers: Array<{ id: string }> }>("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          name: "Scoped key",
          protocol: "openai-chat",
          baseURL: "https://first.example/v1",
          models: [{ id: "model" }],
          requiresApiKey: true,
        },
      }),
    });
    const providerId = created.activeProviderId;
    await request(`/api/providers/${providerId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "origin-scoped-secret" }),
    });

    const moved = await request<{ providers: Array<{ id: string; hasKey: boolean }> }>(`/api/providers/${providerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: { baseURL: "https://second.example/v1" } }),
    });
    expect(moved.providers.find((provider) => provider.id === providerId)?.hasKey).toBe(false);
    expect(await readFile(join(dataDir, "kyrei-secrets.json"), "utf8")).not.toContain("origin-scoped-secret");
  });

  it("clears an ID-colliding secret when imported protocol metadata changes", async () => {
    const initial = await request<{ activeProviderId: string }>("/api/config");
    await request(`/api/providers/${initial.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "collision-secret" }),
    });

    const imported = await request<{ providers: Array<{ id: string; hasKey: boolean }> }>("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: [{
          id: initial.activeProviderId,
          name: "Gemini collision",
          protocol: "google-generative-ai",
          baseURL: "https://generativelanguage.googleapis.com/v1beta",
          models: [{ id: "gemini-2.5-pro" }],
          requiresApiKey: true,
        }],
        activeProviderId: initial.activeProviderId,
        activeModelId: "gemini-2.5-pro",
      }),
    });
    expect(imported.providers[0]?.hasKey).toBe(false);
    expect(await readFile(join(dataDir, "kyrei-secrets.json"), "utf8")).not.toContain("collision-secret");
  });

  it("stores Bedrock credentials in the secret file without exposing them", async () => {
    const created = await request<{ providers: Array<{ id: string; name: string }>; activeProviderId: string }>("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          name: "Bedrock",
          protocol: "amazon-bedrock",
          models: [{ id: "anthropic.claude" }],
          requiresApiKey: true,
        },
      }),
    });
    const bedrock = created.providers.find((provider) => provider.name === "Bedrock")!;
    await expect(request(`/api/providers/${bedrock.id}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { region: "us-east-1", accessKeyId: "missing-secret" } }),
    })).rejects.toThrow("provider_credentials_incomplete");

    const configured = await request<{ providers: Array<{ id: string; hasKey: boolean }> }>(`/api/providers/${bedrock.id}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentials: {
          region: "us-east-1",
          accessKeyId: "access-id",
          secretAccessKey: "secret-value",
          ignored: "not-allowed",
        },
      }),
    });
    expect(configured.providers.find((provider) => provider.id === bedrock.id)?.hasKey).toBe(true);
    expect(JSON.stringify(configured)).not.toMatch(/access-id|secret-value/);

    const stored = await readFile(join(dataDir, "kyrei-secrets.json"), "utf8");
    expect(stored).toContain("secret-value");
    expect(stored).not.toContain("not-allowed");
  });

  it("supports an OS-backed secret codec and reloads the encrypted envelope", async () => {
    server.close();
    await rm(dataDir, { recursive: true, force: true });
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-encrypted-"));
    const secretsCodec = {
      encode: (value: string) => Buffer.from(`protected:${value}`, "utf8").toString("base64"),
      decode: (value: string) => Buffer.from(value, "base64").toString("utf8").replace(/^protected:/, ""),
    };
    server = await startGateway({ dataDir, preferredPort: 0, secretsCodec });

    const initial = await request<{ activeProviderId: string }>("/api/config");
    await request(`/api/providers/${initial.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "encrypted-secret-value" }),
    });
    const stored = await readFile(join(dataDir, "kyrei-secrets.json"), "utf8");
    expect(stored).toContain("electron-safe-storage");
    expect(stored).not.toContain("encrypted-secret-value");

    server.close();
    server = await startGateway({ dataDir, preferredPort: 0, secretsCodec });
    const reloaded = await request<{ hasKey: boolean }>("/api/config");
    expect(reloaded.hasKey).toBe(true);
  });

  it("clears stored credentials when explicit authentication is disabled", async () => {
    const initial = await request<{ activeProviderId: string }>("/api/config");
    await request(`/api/providers/${initial.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "must-be-cleared" }),
    });

    const updated = await request<{ providers: Array<{ id: string; hasKey: boolean; hasStoredCredentials: boolean }> }>(
      `/api/providers/${initial.activeProviderId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: { requiresApiKey: false } }),
      },
    );

    expect(updated.providers.find(provider => provider.id === initial.activeProviderId)).toMatchObject({
      hasKey: true,
      hasStoredCredentials: false,
    });
    expect(await readFile(join(dataDir, "kyrei-secrets.json"), "utf8")).not.toContain("must-be-cleared");
  });
});
