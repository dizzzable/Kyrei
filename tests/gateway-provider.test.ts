import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as nodeRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../core/gateway.js";

let dataDir = "";
let server: { port: number; token: string; close(): void | Promise<void> };

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "kyrei-gateway-provider-"));
  server = await startGateway({ dataDir, preferredPort: 0 });
});

afterEach(async () => {
  try {
    await server.close();
  } catch {
    /* ignore */
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(dataDir, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
});

async function restartGateway(options: Record<string, unknown> = {}) {
  await server.close();
  server = await startGateway({ dataDir, preferredPort: 0, ...options });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: { "X-Kyrei-Gateway-Token": server.token, ...(init?.headers ?? {}) },
  });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status}`);
  return body;
}

async function configureTwoAccountPool({
  primarySecret = "primary-account-private",
  backupSecret = "backup-account-private",
} = {}) {
  const config = await request<{ activeProviderId: string; activeModelId: string }>("/api/config");
  await request(`/api/providers/${config.activeProviderId}/secret`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: primarySecret }),
  });
  await request(`/api/providers/${config.activeProviderId}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account: { id: "backup", name: "Backup" },
      credentials: { apiKey: backupSecret },
    }),
  });
  await request(`/api/providers/${config.activeProviderId}/pool`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, strategy: "balanced", sessionAffinity: true }),
  });
  return { providerId: config.activeProviderId, modelId: config.activeModelId };
}

async function chunkedJsonRequest<T>(path: string, payload: string, splitAt: number): Promise<T> {
  const data = Buffer.from(payload, "utf8");
  return new Promise((resolve, reject) => {
    const outgoing = nodeRequest({
      hostname: "127.0.0.1",
      port: server.port,
      path,
      method: "POST",
      headers: {
        "X-Kyrei-Gateway-Token": server.token,
        "Content-Type": "application/json",
        "Content-Length": data.byteLength,
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T & { error?: string };
        if ((incoming.statusCode ?? 500) >= 400) reject(new Error(body.error ?? String(incoming.statusCode)));
        else resolve(body);
      });
    });
    outgoing.on("error", reject);
    outgoing.write(data.subarray(0, splitAt));
    setTimeout(() => outgoing.end(data.subarray(splitAt)), 10);
  });
}

async function openEventStream(sessionId: string) {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const outgoing = nodeRequest({
    hostname: "127.0.0.1",
    port: server.port,
    path: `/api/events?session=${encodeURIComponent(sessionId)}`,
    method: "GET",
    headers: { "X-Kyrei-Gateway-Token": server.token },
  });
  const incoming = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    outgoing.once("response", resolve);
    outgoing.once("error", reject);
    outgoing.end();
  });
  let buffer = "";
  incoming.setEncoding("utf8");
  incoming.on("data", (chunk: string) => {
    buffer += chunk;
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (data) events.push(JSON.parse(data));
      boundary = buffer.indexOf("\n\n");
    }
  });
  return {
    events,
    close: () => {
      incoming.destroy();
      outgoing.destroy();
    },
  };
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

  it("returns a stable JSON error without echoing malformed request secrets", async () => {
    const marker = ["review", "secret", "marker"].join("-");
    const response = await fetch(`http://127.0.0.1:${server.port}/api/providers/discover`, {
      method: "POST",
      headers: {
        "X-Kyrei-Gateway-Token": server.token,
        "Content-Type": "application/json",
      },
      body: `{"apiKey":"${marker}",`,
    });
    const raw = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(raw)).toEqual({ code: "invalid_json", error: "invalid_json" });
    expect(raw).not.toContain(marker);
  });

  it("migrates to a registry and never returns provider secrets", async () => {
    const initial = await request<{ providers: unknown[]; activeProviderId: string }>("/api/config");
    expect(initial.providers).toHaveLength(1);

    const created = await request<{ providers: Array<{ id: string; name: string }>; activeProviderId: string }>("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "local-two",
          name: "Local two",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:1234/v1",
          models: [{ id: "shared" }],
          requiresApiKey: false,
        },
      }),
    });
    expect(created.providers).toHaveLength(2);
    const local = created.providers.find((provider) => provider.name === "Local two")!;
    // First ready provider (no key required) auto-promotes when the seed default is still unready.
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
        activeProviderId: "local",
        activeModelId: "llama",
      }),
    });
    expect(imported.activeProviderId).toBe("local");
    expect(imported.activeModelId).toBe("llama");
    expect(imported.providers).toHaveLength(2);
    expect(imported.providers.find((provider) => provider.id === "gemini")?.hasKey).toBe(false);
  });

  it("preserves the current default when a registry import omits selection fields", async () => {
    const initial = await request<{ activeProviderId: string; activeModelId: string }>("/api/config");
    const created = await request<{ providers: unknown[] }>("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: {
        id: "imported-without-selection",
        name: "Imported without selection",
        protocol: "openai-chat",
        baseURL: "https://models.example/v1",
        models: [{ id: "other-model" }],
        requiresApiKey: true,
      } }),
    });
    const imported = await request<{ activeProviderId: string; activeModelId: string }>("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: created.providers }),
    });
    expect(imported).toMatchObject({
      activeProviderId: initial.activeProviderId,
      activeModelId: initial.activeModelId,
    });
  });

  it("strictly rejects malformed registry imports and unbounded model selection without mutation", async () => {
    const before = await request<{ providers: Array<{ id: string }>; activeProviderId: string; activeModelId: string }>("/api/config");
    await expect(request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers: [{
        id: "invalid-import",
        name: "Invalid import",
        protocol: "unknown-transport",
        baseURL: "file:///tmp/provider",
        models: [{ id: "model" }],
      }] }),
    })).rejects.toThrow("provider_protocol_invalid");
    await expect(request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeModelId: "x".repeat(513) }),
    })).rejects.toThrow("provider_model_invalid");
    await expect(request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeModelId: "unknown-short-model" }),
    })).rejects.toThrow("provider_model_unavailable");

    const after = await request<{ providers: Array<{ id: string }>; activeProviderId: string; activeModelId: string }>("/api/config");
    expect(after).toMatchObject({
      activeProviderId: before.activeProviderId,
      activeModelId: before.activeModelId,
    });
    expect(after.providers.map((provider) => provider.id)).toEqual(before.providers.map((provider) => provider.id));
  });

  it("clears stored credentials when a profile moves to another origin", async () => {
    const created = await request<{ activeProviderId: string; providers: Array<{ id: string }> }>("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "scoped-key",
          name: "Scoped key",
          protocol: "openai-chat",
          baseURL: "https://first.example/v1",
          models: [{ id: "model" }],
          requiresApiKey: true,
        },
        apiKey: "origin-scoped-secret",
        useAsDefault: true,
      }),
    });
    const providerId = created.activeProviderId;

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
          id: "bedrock",
          name: "Bedrock",
          protocol: "amazon-bedrock",
          baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
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
    await server.close();
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

    await server.close();
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

  it("honours an explicit stable id and activates only with useAsDefault", async () => {
    const initial = await request<{ activeProviderId: string }>("/api/config");
    const created = await request<{
      activeProviderId: string;
      providers: Array<{ id: string; name: string }>;
    }>("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "xpiki",
          displayName: "Xpiki",
          protocol: "openai-chat",
          baseURL: "https://models.example/v1",
          models: [{ id: "chat-model" }],
          requiresApiKey: true,
        },
      }),
    });
    expect(created.activeProviderId).toBe(initial.activeProviderId);
    expect(created.providers.find((provider) => provider.id === "xpiki")).toMatchObject({ name: "Xpiki" });

    const renamed = await request<typeof created>("/api/providers/xpiki", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: { displayName: "Xpiki Cloud" } }),
    });
    expect(renamed.activeProviderId).toBe(initial.activeProviderId);
    expect(renamed.providers.find((provider) => provider.id === "xpiki")?.name).toBe("Xpiki Cloud");

    await request("/api/providers/xpiki/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "xpiki-test-credential" }),
    });

    const activated = await request<typeof created>("/api/providers/xpiki", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: {}, useAsDefault: true, modelId: "chat-model" }),
    });
    expect(activated.activeProviderId).toBe("xpiki");
  });

  it("decodes a provider display name when UTF-8 is split across TCP chunks", async () => {
    const payload = JSON.stringify({ provider: {
      id: "utf8-provider",
      name: "Кирей",
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      models: [{ id: "model" }],
      requiresApiKey: false,
    } });
    const bytes = Buffer.from(payload, "utf8");
    const firstMultibyte = bytes.indexOf(Buffer.from("К", "utf8"));
    const created = await chunkedJsonRequest<{ providers: Array<{ id: string; name: string }> }>(
      "/api/providers",
      payload,
      firstMultibyte + 1,
    );
    expect(created.providers.find((provider) => provider.id === "utf8-provider")?.name).toBe("Кирей");
  });

  it("keeps the provider registry unchanged when create validation or activation fails", async () => {
    const before = await request<{ providers: Array<{ id: string }>; activeProviderId: string }>("/api/providers");
    await expect(request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "incomplete-bedrock",
          name: "Incomplete Bedrock",
          protocol: "amazon-bedrock",
          baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
          models: [{ id: "model" }],
          requiresApiKey: true,
        },
        credentials: { region: "us-east-1", accessKeyId: "missing-secret" },
      }),
    })).rejects.toThrow("provider_credentials_incomplete");

    await expect(request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "disabled-default",
          name: "Disabled default",
          protocol: "openai-chat",
          baseURL: "https://models.example/v1",
          models: [{ id: "model" }],
          enabled: false,
          requiresApiKey: false,
        },
        useAsDefault: true,
      }),
    })).rejects.toThrow("provider_unavailable");

    await expect(request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "missing-key-default",
          name: "Missing key default",
          protocol: "openai-chat",
          baseURL: "https://models.example/v1",
          models: [{ id: "model" }],
          requiresApiKey: true,
        },
        useAsDefault: true,
      }),
    })).rejects.toThrow("provider_credentials_required");

    const after = await request<{ providers: Array<{ id: string }>; activeProviderId: string }>("/api/providers");
    expect(after.activeProviderId).toBe(before.activeProviderId);
    expect(after.providers.map((provider) => provider.id)).toEqual(before.providers.map((provider) => provider.id));
  });

  it("returns versioned templates without proprietary or secret metadata", async () => {
    const result = await request<{ version: number; templates: Array<Record<string, unknown>> }>("/api/provider-templates");
    expect(result.version).toBeGreaterThan(0);
    expect(result.templates.at(-1)?.id).toBe("custom");
    expect(JSON.stringify(result)).not.toMatch(/nous|hermes|oauth|copilot|"apiKey"\s*:|secret/i);
  });

  it("discovers draft and stored-profile models without mutating config or returning credentials", async () => {
    const providerDiscovery = vi.fn(async () => [{ id: "discovered-model", name: "Discovered" }]);
    await restartGateway({ providerDiscovery });
    const before = await request<{ providers: unknown[]; activeProviderId: string }>("/api/config");
    const credential = ["test", "credential"].join("-");

    const draft = await request<{ models: Array<{ id: string }>; count: number }>("/api/providers/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: {
          protocol: "openai-chat",
          baseURL: "https://models.example/v1",
          requiresApiKey: true,
        },
        apiKey: credential,
      }),
    });
    expect(draft).toEqual({ models: [{ id: "discovered-model", name: "Discovered" }], count: 1 });
    expect(JSON.stringify(draft)).not.toContain(credential);
    const afterDraftDiscovery = await request("/api/config");
    expect(afterDraftDiscovery).toMatchObject(before);
    expect(providerDiscovery).toHaveBeenLastCalledWith(expect.objectContaining({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: { apiKey: credential },
      trustedEndpoint: true,
    }));

    await request("/api/providers/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: {
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:11434/v1",
          requiresApiKey: false,
        },
        apiKey: credential,
      }),
    });
    expect(providerDiscovery).toHaveBeenLastCalledWith(expect.objectContaining({ credentials: {} }));

    await request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: {
        id: "saved-provider",
        name: "Saved provider",
        protocol: "openai-chat",
        baseURL: "https://saved.example/v1",
        models: [{ id: "manual-model" }],
        requiresApiKey: true,
      } }),
    });
    await request("/api/providers/saved-provider/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: credential }),
    });
    const saved = await request<{ models: Array<{ id: string }> }>("/api/providers/saved-provider/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(saved.models).toEqual([{ id: "discovered-model", name: "Discovered" }]);
    expect(providerDiscovery).toHaveBeenLastCalledWith(expect.objectContaining({
      baseURL: "https://saved.example/v1",
      credentials: { apiKey: credential },
      trustedEndpoint: true,
    }));

    const anthropic = await request<{ models: Array<{ id: string }>; count: number }>("/api/providers/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: {
          id: "anthropic",
          protocol: "anthropic-messages",
          baseURL: "https://api.anthropic.com/v1",
          requiresApiKey: true,
        },
        apiKey: credential,
      }),
    });
    expect(anthropic).toEqual({ models: [{ id: "discovered-model", name: "Discovered" }], count: 1 });
    expect(providerDiscovery).toHaveBeenLastCalledWith(expect.objectContaining({
      providerId: "anthropic",
      protocol: "anthropic-messages",
      baseURL: "https://api.anthropic.com/v1",
      credentials: { apiKey: credential },
    }));
  });

  it("rejects renderer-forged live metadata until an exact discovery receipt exists", async () => {
    const baseURL = "http://127.0.0.1:12455/v1";
    const modelId = "receipt-model";
    const discovered = {
      limits: { contextWindow: 72_000, maxOutput: 7_200 },
      provenance: {
        source: "live-provider",
        confidence: "high",
        fields: {
          contextWindow: { source: "live-provider", confidence: "high" },
          maxOutput: { source: "live-provider", confidence: "high" },
        },
      },
    };
    const submitted = {
      ...discovered,
      provenance: {
        ...discovered.provenance,
        origin: { protocol: "openai-chat", baseURL, modelId },
      },
    };
    const providerDiscovery = vi.fn(async () => [{ id: modelId, capabilities: discovered }]);
    await restartGateway({ providerDiscovery });

    await request("/api/providers", {
      method: "POST",
      body: JSON.stringify({ provider: {
        id: "receipt-provider",
        name: "Receipt provider",
        protocol: "openai-chat",
        baseURL,
        models: [{ id: modelId, capabilities: submitted }],
        requiresApiKey: false,
      } }),
    });
    let config = await request<any>("/api/config");
    expect(config.providers.find((provider: any) => provider.id === "receipt-provider")
      ?.models.find((model: any) => model.id === modelId)?.capabilities).toBeUndefined();

    await request("/api/providers/discover", {
      method: "POST",
      body: JSON.stringify({ profile: {
        id: "receipt-provider",
        protocol: "openai-chat",
        baseURL,
        requiresApiKey: false,
      } }),
    });
    await request("/api/providers/receipt-provider", {
      method: "PATCH",
      body: JSON.stringify({ models: [{ id: modelId, capabilities: submitted }] }),
    });

    config = await request<any>("/api/config");
    expect(config.providers.find((provider: any) => provider.id === "receipt-provider")
      ?.models.find((model: any) => model.id === modelId)?.capabilities).toMatchObject({
        limits: { contextWindow: 72_000, maxOutput: 7_200 },
        provenance: { source: "live-provider" },
      });
  });

  it("keeps Settings defaults separate from durable session model overrides and gateway execution", async () => {
    const runKyreiChat = vi.fn(async () => ({ text: "done", parts: [] }));
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    const initial = await request<{ activeProviderId: string; activeModelId: string }>("/api/config");
    const credential = ["session", "credential"].join("-");
    // Make the seed default ready first so a secondary provider does not auto-promote.
    await request(`/api/providers/${initial.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "default-ready-credential" }),
    });

    await request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: {
        id: "session-provider",
        name: "Session provider",
        protocol: "openai-chat",
        baseURL: "https://session.example/v1",
        models: [{ id: "session-model" }, { id: "worker-model" }],
        requiresApiKey: true,
      } }),
    });
    await request("/api/providers/session-provider/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: credential }),
    });
    await request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelAssignments: { worker: { providerId: "session-provider", modelId: "worker-model" } } }),
    });

    const created = await request<{ id: string; session: Record<string, unknown> }>("/api/sessions", { method: "POST" });
    expect(created.session).toMatchObject({ providerId: initial.activeProviderId, modelId: initial.activeModelId });
    const patched = await request<{ session: Record<string, unknown> }>(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "session-provider", modelId: "session-model" }),
    });
    expect(patched.session).toMatchObject({ providerId: "session-provider", modelId: "session-model" });
    expect(await request("/api/config")).toMatchObject({
      activeProviderId: initial.activeProviderId,
      activeModelId: initial.activeModelId,
    });

    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: created.id, text: "Run" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    expect(runKyreiChat).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "session-provider",
      providerBase: "https://session.example/v1",
      model: "session-model",
      apiKey: credential,
      workerProvider: expect.objectContaining({
        providerId: "session-provider",
        baseURL: "https://session.example/v1",
        model: "worker-model",
        apiKey: credential,
      }),
    }));

    const listed = await request<{ sessions: Array<Record<string, unknown>> }>("/api/sessions");
    expect(listed.sessions.find((session) => session.id === created.id)).toMatchObject({
      providerId: "session-provider",
      modelId: "session-model",
    });
  });

  it("resolves ordered fallback assignments into isolated private runtime targets", async () => {
    const runKyreiChat = vi.fn(async () => ({ text: "done", parts: [] }));
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    await request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "fallback-main",
          name: "Fallback main",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:11434/v1",
          models: [{ id: "shared/model" }],
          requiresApiKey: false,
        },
        useAsDefault: true,
      }),
    });
    const fallbackCredential = ["fallback", "private", "credential"].join("-");
    await request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: {
        id: "fallback-backup",
        name: "Fallback backup",
        protocol: "anthropic-messages",
        baseURL: "https://backup.example/v1",
        headers: { "X-Route": "backup" },
        models: [{ id: "shared/model" }],
        requiresApiKey: true,
      } }),
    });
    await request("/api/providers/fallback-backup/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: fallbackCredential }),
    });
    const configured = await request<{ modelAssignments: { fallbacks: Array<{ providerId: string; modelId: string }> } }>("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelAssignments: {
        fallbacks: [{ providerId: "fallback-backup", modelId: "shared/model" }],
      } }),
    });
    expect(configured.modelAssignments.fallbacks).toEqual([
      { providerId: "fallback-backup", modelId: "shared/model" },
    ]);
    expect(JSON.stringify(configured)).not.toContain(fallbackCredential);

    const created = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: created.id, text: "Use fallback if required" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    expect(runKyreiChat).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "fallback-main",
      model: "shared/model",
      fallbackProviders: [{
        providerId: "fallback-backup",
        protocol: "anthropic-messages",
        baseURL: "https://backup.example/v1",
        model: "shared/model",
        apiKey: fallbackCredential,
        credentials: { apiKey: fallbackCredential },
        headers: { "X-Route": "backup" },
        requiresApiKey: true,
      }],
    }));

    const reconciled = await request<{ modelAssignments: { fallbacks: unknown[] } }>("/api/providers/fallback-backup/secret", {
      method: "DELETE",
    });
    expect(reconciled.modelAssignments.fallbacks).toEqual([]);
  });

  it("passes sanitized per-model limits to the primary and fallback runtime targets", async () => {
    const runKyreiChat = vi.fn(async () => ({ text: "done", parts: [], status: "complete" }));
    const discoveredCapabilities = (contextWindow: number, maxOutput: number) => ({
      limits: { contextWindow, maxOutput },
      provenance: {
        source: "live-provider",
        confidence: "high",
        fields: {
          contextWindow: { source: "live-provider", confidence: "high" },
          maxOutput: { source: "live-provider", confidence: "high" },
        },
      },
    });
    const providerDiscovery = vi.fn(async ({ baseURL }: { baseURL: string }) => baseURL.includes("11435")
      ? [{ id: "fallback-rich", capabilities: discoveredCapabilities(40_000, 4_000) }]
      : [{ id: "primary-rich", capabilities: discoveredCapabilities(90_000, 9_000) }]);
    await restartGateway({
      engineLoader: async () => ({ runKyreiChat, listModels: () => [] }),
      providerDiscovery,
    });
    await request("/api/providers/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: {
        id: "limit-main",
        protocol: "openai-chat",
        baseURL: "http://127.0.0.1:11434/v1",
        requiresApiKey: false,
      } }),
    });
    await request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "limit-main",
          name: "Limit main",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:11434/v1",
          models: [{
            id: "primary-rich",
            capabilities: {
              limits: { contextWindow: 90_000, maxOutput: 9_000 },
              provenance: {
                source: "live-provider",
                confidence: "high",
                origin: {
                  protocol: "openai-chat",
                  baseURL: "http://127.0.0.1:11434/v1",
                  modelId: "primary-rich",
                },
                fields: {
                  contextWindow: { source: "live-provider", confidence: "high" },
                  maxOutput: { source: "live-provider", confidence: "high" },
                },
              },
            },
          }],
          requiresApiKey: false,
        },
        useAsDefault: true,
      }),
    });
    await request("/api/providers/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: {
        id: "limit-fallback",
        protocol: "openai-chat",
        baseURL: "http://localhost:11435/v1",
        requiresApiKey: false,
      } }),
    });
    await request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: {
        id: "limit-fallback",
        name: "Limit fallback",
        protocol: "openai-chat",
        baseURL: "http://localhost:11435/v1",
        models: [{
          id: "fallback-rich",
          capabilities: {
            limits: { contextWindow: 40_000, maxOutput: 4_000 },
            provenance: {
              source: "live-provider",
              confidence: "high",
              origin: {
                protocol: "openai-chat",
                baseURL: "http://localhost:11435/v1",
                modelId: "fallback-rich",
              },
              fields: {
                contextWindow: { source: "live-provider", confidence: "high" },
                maxOutput: { source: "live-provider", confidence: "high" },
              },
            },
          },
        }],
        requiresApiKey: false,
      } }),
    });
    await request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelAssignments: {
        fallbacks: [{ providerId: "limit-fallback", modelId: "fallback-rich" }],
      } }),
    });

    const created = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: created.id, text: "Use truthful model limits" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));

    expect(runKyreiChat).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "limit-main",
      model: "primary-rich",
      modelLimits: { contextWindow: 90_000, maxOutput: 9_000 },
      fallbackProviders: [expect.objectContaining({
        providerId: "limit-fallback",
        model: "fallback-rich",
        limits: { contextWindow: 40_000, maxOutput: 4_000 },
      })],
    }));
  });

  it("exposes and assigns only providers whose required credentials are ready", async () => {
    const initial = await request<{ activeProviderId: string; activeModelId: string }>("/api/config");
    await request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: {
        id: "needs-key",
        name: "Needs key",
        protocol: "openai-chat",
        baseURL: "https://needs-key.example/v1",
        models: [{ id: "chat-model" }, { id: "worker-model" }],
        requiresApiKey: true,
      } }),
    });
    const created = await request<{ id: string }>("/api/sessions", { method: "POST" });

    const unavailableModels = await request<{ models: Array<{ provider: string }> }>("/api/models");
    expect(unavailableModels.models.some((model) => model.provider === "needs-key")).toBe(false);
    await expect(request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeProviderId: "needs-key", activeModelId: "chat-model" }),
    })).rejects.toThrow("provider_credentials_required");
    await expect(request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "needs-key", modelId: "chat-model" }),
    })).rejects.toThrow("provider_credentials_required");
    await expect(request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelAssignments: { worker: { providerId: "needs-key", modelId: "worker-model" } } }),
    })).rejects.toThrow("provider_credentials_required");
    expect(await request("/api/config")).toMatchObject({
      activeProviderId: initial.activeProviderId,
      activeModelId: initial.activeModelId,
      modelAssignments: {},
    });

    const credential = ["ready", "credential"].join("-");
    await request("/api/providers/needs-key/secret", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: credential }),
    });
    await request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeProviderId: "needs-key", activeModelId: "chat-model" }),
    });
    await request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: "needs-key", modelId: "chat-model" }),
    });
    const assigned = await request<{ modelAssignments: { worker?: { providerId: string; modelId: string } } }>("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelAssignments: { worker: { providerId: "needs-key", modelId: "worker-model" } } }),
    });
    expect(assigned.modelAssignments.worker).toEqual({ providerId: "needs-key", modelId: "worker-model" });
    const readyModels = await request<{ models: Array<{ provider: string }> }>("/api/models");
    expect(readyModels.models.some((model) => model.provider === "needs-key")).toBe(true);

    const cleared = await request<{ modelAssignments: { worker?: unknown } }>("/api/providers/needs-key/secret", { method: "DELETE" });
    expect(cleared.modelAssignments.worker).toBeUndefined();
  });

  it("selects a ready fallback when active credentials disappear", async () => {
    const initial = await request<{ activeProviderId: string }>("/api/config");
    await request(`/api/providers/${initial.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "initial-ready-credential" }),
    });
    await request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: {
        id: "unready-fallback",
        name: "Unready fallback",
        protocol: "openai-chat",
        baseURL: "https://unready.example/v1",
        models: [{ id: "unready-model" }],
        requiresApiKey: true,
      } }),
    });
    for (const id of ["ready-c", "ready-d"]) {
      await request("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: {
            id,
            name: id,
            protocol: "openai-chat",
            baseURL: `https://${id}.example/v1`,
            models: [{ id: `${id}-model` }],
            requiresApiKey: true,
          },
          apiKey: `${id}-credential`,
        }),
      });
    }

    const afterDelete = await request<{ activeProviderId: string }>(
      `/api/providers/${initial.activeProviderId}`,
      { method: "DELETE" },
    );
    expect(afterDelete.activeProviderId).toBe("ready-c");

    const afterScopeChange = await request<{
      activeProviderId: string;
      providers: Array<{ id: string; hasKey: boolean }>;
    }>("/api/providers/ready-c", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: { baseURL: "https://ready-c-moved.example/v1" } }),
    });
    expect(afterScopeChange.activeProviderId).toBe("ready-d");
    expect(afterScopeChange.providers.find((provider) => provider.id === "ready-c")?.hasKey).toBe(false);
  });

  it("emits the migrated session model before running a stale session target", async () => {
    const runKyreiChat = vi.fn(async () => ({ text: "done", parts: [] }));
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    const initial = await request<{ activeProviderId: string; activeModelId: string }>("/api/config");
    await request(`/api/providers/${initial.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "fallback-runtime-credential" }),
    });
    await request("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "stale-session-provider",
          name: "Stale session provider",
          protocol: "openai-chat",
          baseURL: "http://127.0.0.1:11434/v1",
          models: [{ id: "stale-model" }],
          requiresApiKey: false,
        },
        useAsDefault: true,
      }),
    });
    const created = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activeProviderId: initial.activeProviderId,
        activeModelId: initial.activeModelId,
      }),
    });
    await request("/api/providers/stale-session-provider", { method: "DELETE" });

    const stream = await openEventStream(created.id);
    try {
      await vi.waitFor(() => expect(stream.events.some((event) => event.type === "gateway.ready")).toBe(true));
      await request("/api/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: created.id, text: "Run stale session" }),
      });
      await vi.waitFor(() => expect(stream.events).toContainEqual({
        type: "session.model",
        payload: {
          session_id: created.id,
          provider_id: initial.activeProviderId,
          model_id: initial.activeModelId,
        },
      }));
      await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    } finally {
      stream.close();
    }
  });

  it("OOB first-run: creating a ready provider without useAsDefault rebinds idle sessions and chats", async () => {
    const runKyreiChat = vi.fn(async () => ({ text: "hello", parts: [] }));
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });

    const initial = await request<{ activeProviderId: string; activeModelId: string }>("/api/config");
    // Fresh install session is snapshotted to the unready default stub.
    const created = await request<{ id: string; providerId?: string; modelId?: string }>("/api/sessions", {
      method: "POST",
    });
    expect(created.providerId ?? initial.activeProviderId).toBe(initial.activeProviderId);

    // User connects a real provider and pastes a key — without ticking useAsDefault.
    const activated = await request<{
      activeProviderId: string;
      activeModelId: string;
      providers: Array<{ id: string; hasKey: boolean }>;
    }>("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: {
          id: "oob-openai",
          name: "OpenAI",
          protocol: "openai-chat",
          baseURL: "https://api.openai.com/v1",
          models: [{ id: "gpt-4o-mini" }],
          requiresApiKey: true,
        },
        apiKey: "sk-oob-first-run",
      }),
    });
    expect(activated.activeProviderId).toBe("oob-openai");
    expect(activated.activeModelId).toBe("gpt-4o-mini");
    expect(activated.providers.find((provider) => provider.id === "oob-openai")?.hasKey).toBe(true);

    const sessions = await request<{ sessions: Array<{ id: string; providerId?: string; modelId?: string }> }>(
      "/api/sessions",
    );
    const rebound = sessions.sessions.find((session) => session.id === created.id);
    expect(rebound).toMatchObject({ providerId: "oob-openai", modelId: "gpt-4o-mini" });

    const stream = await openEventStream(created.id);
    try {
      await vi.waitFor(() => expect(stream.events.some((event) => event.type === "gateway.ready")).toBe(true));
      await request("/api/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: created.id, text: "Hi" }),
      });
      await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
      expect(runKyreiChat).toHaveBeenCalledWith(expect.objectContaining({
        providerId: "oob-openai",
        model: "gpt-4o-mini",
        apiKey: "sk-oob-first-run",
      }));
    } finally {
      stream.close();
    }
  });

  it("keeps a valid registry import atomic when its explicit selection is invalid", async () => {
    const before = await request<{ providers: Array<{ id: string }>; activeProviderId: string }>("/api/config");
    await expect(request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: [{
          id: "atomic-import",
          name: "Atomic import",
          protocol: "openai-chat",
          baseURL: "https://atomic.example/v1",
          models: [{ id: "model" }],
          requiresApiKey: true,
        }],
        activeProviderId: "missing",
        activeModelId: "model",
      }),
    })).rejects.toThrow("provider_unavailable");
    const after = await request<{ providers: Array<{ id: string }>; activeProviderId: string }>("/api/config");
    expect(after.activeProviderId).toBe(before.activeProviderId);
    expect(after.providers.map((provider) => provider.id)).toEqual(before.providers.map((provider) => provider.id));
  });

  it("manages provider account pools without returning credentials", async () => {
    const config = await request<{ activeProviderId: string }>("/api/config");
    const providerId = config.activeProviderId;
    const primarySecret = "pool-primary-private";
    const backupSecret = "pool-backup-private";
    await request(`/api/providers/${providerId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: primarySecret }),
    });
    const created = await request<{
      pool: { enabled: boolean };
      accounts: Array<{
        id: string;
        primary: boolean;
        hasStoredCredentials: boolean;
        status: string;
        cooldownUntil: number;
        inflight: number;
      }>;
    }>(`/api/providers/${providerId}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account: { id: "backup", name: "Backup", weight: 2, maxConcurrency: 3 },
        credentials: { apiKey: backupSecret },
      }),
    });
    expect(created.pool.enabled).toBe(false);
    expect(created.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "primary", primary: true, hasStoredCredentials: true }),
      expect.objectContaining({
        id: "backup",
        primary: false,
        hasStoredCredentials: true,
        status: "ready",
        cooldownUntil: 0,
        inflight: 0,
      }),
    ]));
    expect(JSON.stringify(created)).not.toMatch(/pool-primary-private|pool-backup-private/);

    const enabled = await request<{
      pool: { enabled: boolean; strategy: string; sessionAffinity: boolean };
    }>(`/api/providers/${providerId}/pool`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pool: { enabled: true, strategy: "balanced", sessionAffinity: true } }),
    });
    expect(enabled.pool).toEqual({ enabled: true, strategy: "balanced", sessionAffinity: true });

    const primaryDelete = await fetch(`http://127.0.0.1:${server.port}/api/providers/${providerId}/accounts/primary`, {
      method: "DELETE",
      headers: { "X-Kyrei-Gateway-Token": server.token },
    });
    expect(primaryDelete.status).toBe(409);

    await restartGateway();
    const persisted = await request<{ pool: { enabled: boolean }; accounts: Array<{ id: string }> }>(`/api/providers/${providerId}/accounts`);
    expect(persisted.pool.enabled).toBe(true);
    expect(persisted.accounts.map((account) => account.id)).toEqual(["primary", "backup"]);
    await request(`/api/providers/${providerId}/accounts/backup`, { method: "DELETE" });
    const afterDelete = await request<{ pool: { enabled: boolean }; accounts: Array<{ id: string }> }>(`/api/providers/${providerId}/accounts`);
    expect(afterDelete.pool.enabled).toBe(false);
    expect(afterDelete.accounts.map((account) => account.id)).toEqual(["primary"]);
  });

  it("validates and routes account model rules before invoking the engine", async () => {
    const runKyreiChat = vi.fn(async (opts: Record<string, unknown>) => ({
      text: "model-scoped",
      parts: [],
      status: "complete",
      route: {
        providerId: opts.providerId,
        modelId: opts.model,
        accountId: opts.providerAccountId,
      },
    }));
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    const config = await request<{
      activeProviderId: string;
      activeModelId: string;
      providers: Array<{ id: string; models: Array<{ id: string }> }>;
    }>("/api/config");
    const providerId = config.activeProviderId;
    const secondModelId = "kyrei-model-b";
    const provider = config.providers.find((candidate) => candidate.id === providerId)!;
    await request(`/api/providers/${providerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: { models: [...provider.models, { id: secondModelId }] },
      }),
    });
    await request(`/api/providers/${providerId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "model-primary-private" }),
    });
    await request(`/api/providers/${providerId}/accounts/primary`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: { modelIds: [config.activeModelId] } }),
    });
    const created = await request<{
      accounts: Array<{ id: string; modelIds?: string[] }>;
    }>(`/api/providers/${providerId}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account: { id: "model-b", name: "Model B", modelIds: [secondModelId, secondModelId] },
        credentials: { apiKey: "model-b-private" },
      }),
    });
    expect(created.accounts.find((account) => account.id === "primary")?.modelIds)
      .toEqual([config.activeModelId]);
    expect(created.accounts.find((account) => account.id === "model-b")?.modelIds)
      .toEqual([secondModelId]);
    await expect(request(`/api/providers/${providerId}/accounts/model-b`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: { modelIds: ["unknown-model"] } }),
    })).rejects.toThrow("provider_account_models_invalid");
    await request(`/api/providers/${providerId}/pool`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, strategy: "balanced", sessionAffinity: true }),
    });
    const assigned = await request<{
      activeModelId: string;
      modelAssignments: {
        worker?: { providerId: string; modelId: string };
        fallbacks: Array<{ providerId: string; modelId: string }>;
      };
    }>("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activeProviderId: providerId,
        activeModelId: secondModelId,
        modelAssignments: {
          worker: { providerId, modelId: secondModelId },
          fallbacks: [{ providerId, modelId: secondModelId }],
        },
      }),
    });
    expect(assigned).toMatchObject({
      activeModelId: secondModelId,
      modelAssignments: {
        worker: { providerId, modelId: secondModelId },
        fallbacks: [{ providerId, modelId: secondModelId }],
      },
    });

    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, modelId: secondModelId }),
    });
    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session.id, text: "Use the assigned model account" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    expect(runKyreiChat).toHaveBeenCalledWith(expect.objectContaining({
      providerAccountId: "model-b",
      model: secondModelId,
      apiKey: "model-b-private",
    }));
    const call = runKyreiChat.mock.calls[0]?.[0] as { fallbackProviders?: Array<{ accountId?: string }> };
    expect(call.fallbackProviders ?? []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: "primary" }),
    ]));

    const denied = await request<{ accounts: Array<{ id: string; modelIds?: string[] }> }>(
      `/api/providers/${providerId}/accounts/model-b`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: { modelIds: [] } }),
      },
    );
    expect(denied.accounts.find((account) => account.id === "model-b")?.modelIds).toEqual([]);
    const reconciled = await request<{
      activeProviderId: string;
      activeModelId: string;
      modelAssignments: { worker?: unknown; fallbacks: unknown[] };
    }>("/api/config");
    expect(reconciled).toMatchObject({
      activeProviderId: providerId,
      activeModelId: config.activeModelId,
      modelAssignments: { fallbacks: [] },
    });
    expect(reconciled.modelAssignments.worker).toBeUndefined();
    const stream = await openEventStream(session.id);
    try {
      await request("/api/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: session.id, text: "Do not invoke an ineligible account" }),
      });
      await vi.waitFor(() => expect(stream.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "error", payload: { code: "provider_not_configured" } }),
      ])));
      expect(runKyreiChat).toHaveBeenCalledTimes(1);
    } finally {
      stream.close();
    }

    await request(`/api/providers/${providerId}/accounts/model-b`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: { modelIds: null } }),
    });
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    const persisted = await request<{
      accounts: Array<{ id: string; modelIds?: string[] }>;
    }>(`/api/providers/${providerId}/accounts`);
    expect(Object.hasOwn(persisted.accounts.find((account) => account.id === "model-b")!, "modelIds")).toBe(false);

    await request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activeProviderId: providerId,
        activeModelId: secondModelId,
        modelAssignments: {
          worker: { providerId, modelId: secondModelId },
          fallbacks: [{ providerId, modelId: secondModelId }],
        },
      }),
    });
    await request(`/api/providers/${providerId}/pool`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const poolReconciled = await request<{
      activeModelId: string;
      modelAssignments: { worker?: unknown; fallbacks: unknown[] };
    }>("/api/config");
    expect(poolReconciled.activeModelId).toBe(config.activeModelId);
    expect(poolReconciled.modelAssignments).toEqual({ fallbacks: [] });
  });

  it("chooses the first deterministic ready provider/model when the active account loses eligibility", async () => {
    const initial = await request<{ activeProviderId: string }>("/api/config");
    await request(`/api/providers/${initial.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "active-private" }),
    });
    for (const [id, models] of [
      ["fallback-first", [{ id: "first-model" }, { id: "second-model" }]],
      ["fallback-later", [{ id: "later-model" }]],
    ] as const) {
      await request("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: {
            id,
            name: id,
            protocol: "openai-chat",
            baseURL: `http://127.0.0.1/${id}/v1`,
            models,
            requiresApiKey: false,
          },
        }),
      });
    }

    await request(`/api/providers/${initial.activeProviderId}/accounts/primary`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: { modelIds: [] } }),
    });
    expect(await request("/api/config")).toMatchObject({
      activeProviderId: "fallback-first",
      activeModelId: "first-model",
    });
  });

  it("purges orphaned account credentials during bulk provider replacement", async () => {
    const current = await request<{
      activeProviderId: string;
      activeModelId: string;
      providers: Array<{
        id: string;
        accountPool: { members: Array<{ id: string }> };
      }>;
    }>("/api/config");
    const providerId = current.activeProviderId;
    const orphanMarker = "orphan-account-private-marker";
    await request(`/api/providers/${providerId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "primary-private-marker" }),
    });
    await request(`/api/providers/${providerId}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account: { id: "orphan", name: "Orphan" },
        credentials: { apiKey: orphanMarker },
      }),
    });

    await request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activeProviderId: current.activeProviderId,
        activeModelId: current.activeModelId,
        providers: current.providers.map((provider) => ({
          ...provider,
          accountPool: {
            ...provider.accountPool,
            members: provider.accountPool.members.filter((member) => member.id !== "orphan"),
          },
        })),
      }),
    });

    expect(await readFile(join(dataDir, "kyrei-secrets.json"), "utf8")).not.toContain(orphanMarker);
    await expect(request(`/api/providers/${providerId}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: { id: "orphan", name: "Orphan again" } }),
    })).rejects.toThrow("provider_credentials_incomplete");
  });

  it("redacts configured account credentials before persisting prompts and titles", async () => {
    const runKyreiChat = vi.fn(async (opts: Record<string, unknown>) => ({
      text: "ok",
      parts: [],
      status: "complete",
      route: { providerId: opts.providerId, modelId: opts.model, accountId: opts.providerAccountId },
      attempts: [],
    }));
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    const config = await request<{ activeProviderId: string }>("/api/config");
    const secretMarker = "configured-account-private-marker";
    await request(`/api/providers/${config.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: secretMarker }),
    });
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session.id, text: `do not persist ${secretMarker}` }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      const history = await request<{ messages: Array<{ content: string }> }>(`/api/sessions/${session.id}/messages`);
      expect(history.messages.some((message) => message.content === "ok")).toBe(true);
    });

    const call = runKyreiChat.mock.calls[0]?.[0] as { messages?: Array<{ content: string }> };
    expect(JSON.stringify(call.messages)).not.toContain(secretMarker);
    expect(JSON.stringify(call.messages)).toContain("[REDACTED]");
    const history = await request(`/api/sessions/${session.id}/messages`);
    const sessions = await request("/api/sessions");
    expect(JSON.stringify({ history, sessions })).not.toContain(secretMarker);
    await vi.waitFor(async () => {
      expect(await readFile(join(dataDir, "state.json"), "utf8")).not.toContain(secretMarker);
    });

    await request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `renamed ${secretMarker}` }),
    });
    expect(JSON.stringify(await request("/api/sessions"))).not.toContain(secretMarker);
  });

  it("orders same-provider accounts before other fallbacks and persists the winning affinity", async () => {
    const runKyreiChat = vi.fn(async (opts: Record<string, unknown>) => ({
      text: "done",
      parts: [],
      route: {
        providerId: opts.providerId,
        modelId: opts.model,
        accountId: "backup",
      },
    }));
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    const config = await request<{ activeProviderId: string; activeModelId: string }>("/api/config");
    await request(`/api/providers/${config.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "primary-route-secret" }),
    });
    await request(`/api/providers/${config.activeProviderId}/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account: { id: "backup", name: "Backup" },
        credentials: { apiKey: "backup-route-secret" },
      }),
    });
    await request(`/api/providers/${config.activeProviderId}/pool`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, strategy: "balanced", sessionAffinity: true }),
    });
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session.id, text: "Route once" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    expect(runKyreiChat).toHaveBeenLastCalledWith(expect.objectContaining({
      providerAccountId: "primary",
      apiKey: "primary-route-secret",
      fallbackProviders: expect.arrayContaining([
        expect.objectContaining({
          providerId: config.activeProviderId,
          accountId: "backup",
          model: config.activeModelId,
          apiKey: "backup-route-secret",
        }),
      ]),
    }));
    await vi.waitFor(async () => {
      const sessions = await request<{ sessions: Array<{ id: string; providerAccountId?: string }> }>("/api/sessions");
      expect(sessions.sessions.find((candidate) => candidate.id === session.id)?.providerAccountId).toBe("backup");
    });

    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session.id, text: "Route again" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(2));
    expect(runKyreiChat).toHaveBeenLastCalledWith(expect.objectContaining({
      providerAccountId: "backup",
      apiKey: "backup-route-secret",
    }));
  });

  it("applies per-attempt cooldown and releases every account lease after fallback", async () => {
    const runKyreiChat = vi.fn(async (rawOpts: Record<string, unknown>) => {
      const lifecycle = rawOpts.providerAttemptLifecycle as {
        acquire(target: Record<string, unknown>): unknown | null;
        release(handle: unknown, outcome: Record<string, unknown>): void;
      };
      const fallback = (rawOpts.fallbackProviders as Array<Record<string, unknown>>)
        .find((target) => target.accountId === "backup")!;
      const primaryTarget = {
        providerId: String(rawOpts.providerId),
        accountId: String(rawOpts.providerAccountId),
        modelId: String(rawOpts.model),
      };
      const backupTarget = {
        providerId: String(fallback.providerId),
        accountId: String(fallback.accountId),
        modelId: String(fallback.model),
      };
      const primaryLease = lifecycle.acquire(primaryTarget);
      if (!primaryLease) throw new Error("primary lease unavailable");
      lifecycle.release(primaryLease, {
        ...primaryTarget,
        outcome: "retryable-error",
        phase: "probe",
        statusCode: 429,
        retryAfterMs: 30_000,
      });
      const backupLease = lifecycle.acquire(backupTarget);
      if (!backupLease) throw new Error("backup lease unavailable");
      lifecycle.release(backupLease, { ...backupTarget, outcome: "success", phase: "stream" });
      return {
        text: "fallback completed",
        parts: [],
        status: "complete",
        route: { providerId: backupTarget.providerId, modelId: backupTarget.modelId, accountId: "backup" },
        attempts: [
          { ...primaryTarget, outcome: "retryable-error", phase: "probe", statusCode: 429, retryAfterMs: 30_000 },
          { ...backupTarget, outcome: "success", phase: "stream" },
        ],
      };
    });
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    const { providerId } = await configureTwoAccountPool();
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });

    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session.id, text: "Use a healthy fallback" }),
    });

    await vi.waitFor(async () => {
      const sessions = await request<{
        sessions: Array<{ id: string; status: string; providerAccountId?: string }>;
      }>("/api/sessions");
      expect(sessions.sessions.find((candidate) => candidate.id === session.id)).toMatchObject({
        status: "idle",
        providerAccountId: "backup",
      });
    });
    const snapshot = await request<{
      accounts: Array<{ id: string; status: string; cooldownUntil: number; inflight: number }>;
    }>(`/api/providers/${providerId}/accounts`);
    expect(snapshot.accounts.find((account) => account.id === "primary")).toMatchObject({
      status: "cooldown",
      inflight: 0,
    });
    expect(snapshot.accounts.find((account) => account.id === "primary")!.cooldownUntil)
      .toBeGreaterThan(Date.now() + 20_000);
    expect(snapshot.accounts.find((account) => account.id === "backup")).toMatchObject({
      status: "ready",
      inflight: 0,
    });
  });

  it("keeps a bare first 401 recoverable without recording a successful turn", async () => {
    const runKyreiChat = vi.fn(async (rawOpts: Record<string, unknown>) => {
      const lifecycle = rawOpts.providerAttemptLifecycle as {
        acquire(target: Record<string, unknown>): unknown | null;
        release(handle: unknown, outcome: Record<string, unknown>): void;
      };
      const target = {
        providerId: String(rawOpts.providerId),
        accountId: String(rawOpts.providerAccountId),
        modelId: String(rawOpts.model),
      };
      const lease = lifecycle.acquire(target);
      if (!lease) throw new Error("primary lease unavailable");
      lifecycle.release(lease, {
        ...target,
        outcome: "terminal-error",
        phase: "probe",
        statusCode: 401,
      });
      return {
        text: "",
        parts: [],
        status: "error",
        route: target,
        attempts: [{ ...target, outcome: "terminal-error", phase: "probe", statusCode: 401 }],
      };
    });
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    const { providerId } = await configureTwoAccountPool();
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });

    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session.id, text: "Reject invalid credentials" }),
    });

    await vi.waitFor(async () => {
      const sessions = await request<{
        sessions: Array<{ id: string; status: string; providerAccountId?: string }>;
      }>("/api/sessions");
      expect(sessions.sessions.find((candidate) => candidate.id === session.id)?.status).toBe("idle");
    });
    const snapshot = await request<{
      accounts: Array<{ id: string; status: string; inflight: number }>;
    }>(`/api/providers/${providerId}/accounts`);
    expect(snapshot.accounts.find((account) => account.id === "primary")).toMatchObject({
      status: "cooldown",
      inflight: 0,
    });
    const history = await request<{ messages: Array<{ role: string }> }>(`/api/sessions/${session.id}/messages`);
    expect(history.messages.map((message) => message.role)).toEqual(["user"]);
    const sessions = await request<{
      sessions: Array<{ id: string; providerAccountId?: string }>;
    }>("/api/sessions");
    expect(sessions.sessions.find((candidate) => candidate.id === session.id)?.providerAccountId).toBeUndefined();
  });

  it("fences a late provider result after its account is deleted", async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    let resolveRun!: (result: Record<string, unknown>) => void;
    const runKyreiChat = vi.fn((opts: Record<string, unknown>) => {
      capturedOpts = opts;
      return new Promise<Record<string, unknown>>((resolve) => { resolveRun = resolve; });
    });
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    const { providerId, modelId } = await configureTwoAccountPool();
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });

    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session.id, text: "Do not accept a stale result" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    await request(`/api/providers/${providerId}/accounts/backup`, { method: "DELETE" });
    expect((capturedOpts?.abortSignal as AbortSignal).aborted).toBe(true);

    resolveRun({
      text: "stale assistant output",
      parts: [],
      status: "complete",
      route: { providerId, modelId, accountId: "backup" },
      attempts: [],
    });
    await vi.waitFor(async () => {
      const sessions = await request<{
        sessions: Array<{ id: string; status: string; providerAccountId?: string }>;
      }>("/api/sessions");
      expect(sessions.sessions.find((candidate) => candidate.id === session.id)).toMatchObject({ status: "idle" });
      expect(sessions.sessions.find((candidate) => candidate.id === session.id)?.providerAccountId).toBeUndefined();
    });
    const history = await request<{ messages: Array<{ content: string }> }>(`/api/sessions/${session.id}/messages`);
    expect(history.messages.some((message) => message.content === "stale assistant output")).toBe(false);
  });

  it("rejects a second simultaneous prompt for the same session", async () => {
    let resolveRun!: (result: Record<string, unknown>) => void;
    let capturedOpts: Record<string, unknown> | undefined;
    const runKyreiChat = vi.fn((opts: Record<string, unknown>) => {
      capturedOpts = opts;
      return new Promise<Record<string, unknown>>((resolve) => { resolveRun = resolve; });
    });
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    const { providerId, modelId } = await configureTwoAccountPool();
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });

    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session.id, text: "First turn" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    const second = await fetch(`http://127.0.0.1:${server.port}/api/prompt`, {
      method: "POST",
      headers: {
        "X-Kyrei-Gateway-Token": server.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session: session.id, text: "Overlapping turn" }),
    });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ code: "session_busy" });

    resolveRun({
      text: "first turn complete",
      parts: [],
      status: "complete",
      route: {
        providerId,
        modelId,
        accountId: String(capturedOpts?.providerAccountId),
      },
      attempts: [],
    });
    await vi.waitFor(async () => {
      const history = await request<{ messages: Array<{ content: string }> }>(`/api/sessions/${session.id}/messages`);
      expect(history.messages.some((message) => message.content === "first turn complete")).toBe(true);
    });
  });

  it("replays stored provider reasoning as structured history on the next turn", async () => {
    let call = 0;
    const runKyreiChat = vi.fn(async (opts: Record<string, unknown>) => {
      call += 1;
      if (call === 1) {
        return {
          text: "Initial conclusion.",
          parts: [{ type: "reasoning", id: "reasoning-1", text: "Checked the project state.", state: "complete" }],
          status: "complete",
          responseMessages: [{
            role: "assistant",
            content: [
              { type: "reasoning", text: "Checked the project state." },
              { type: "text", text: "Initial conclusion." },
            ],
          }],
          route: { providerId: opts.providerId, modelId: opts.model },
          attempts: [],
        };
      }
      return {
        text: "Follow-up conclusion.",
        parts: [],
        status: "complete",
        responseMessages: [],
        route: { providerId: opts.providerId, modelId: opts.model },
        attempts: [],
      };
    });
    await restartGateway({ engineLoader: async () => ({ runKyreiChat, listModels: () => [] }) });
    const config = await request<{ activeProviderId: string }>("/api/config");
    await request(`/api/providers/${config.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "reasoning-replay-test-key" }),
    });
    const session = await request<{ id: string }>("/api/sessions", { method: "POST" });

    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session.id, text: "Inspect the project" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      const history = await request<{ messages: Array<{ content: string }> }>(`/api/sessions/${session.id}/messages`);
      expect(history.messages.some((message) => message.content === "Initial conclusion.")).toBe(true);
    });

    await request("/api/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: session.id, text: "Continue from that work" }),
    });
    await vi.waitFor(() => expect(runKyreiChat).toHaveBeenCalledTimes(2));

    const replayedHistory = (runKyreiChat.mock.calls[1]?.[0] as { messages?: unknown[] }).messages ?? [];
    expect(replayedHistory).toContainEqual({
      role: "assistant",
      content: [
        { type: "reasoning", text: "Checked the project state." },
        { type: "text", text: "Initial conclusion." },
      ],
    });
  });

  it("flushes a newly created session and its model target during gateway shutdown", async () => {
    const config = await request<{ activeProviderId: string; activeModelId: string }>("/api/config");
    await request(`/api/providers/${config.activeProviderId}/secret`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "shutdown-test-credential" }),
    });
    const created = await request<{ id: string }>("/api/sessions", { method: "POST" });
    await request(`/api/sessions/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: config.activeProviderId, modelId: config.activeModelId }),
    });

    await server.close();
    const state = JSON.parse(await readFile(join(dataDir, "state.json"), "utf8"));
    expect(state.sessions.find((session: { id: string }) => session.id === created.id)).toMatchObject({
      providerId: config.activeProviderId,
      modelId: config.activeModelId,
    });
  });
});
