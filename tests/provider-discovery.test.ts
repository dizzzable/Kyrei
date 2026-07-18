import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  ProviderDiscoveryError,
  discoverProviderModels,
} from "../core/provider-discovery.js";

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 as const }];
const benchmarkResolver = async () => [{ address: "198.18.0.127", family: 4 as const }];

function response(status: number, body: string, headers: Record<string, string> = {}) {
  return { status, body, headers };
}

describe("OpenAI-compatible provider discovery", () => {
  it("uses the pinned lookup contract supported by current Node runtimes", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/v1/models");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "local-default-request" }] }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test-server-address-unavailable");

    try {
      await expect(discoverProviderModels({
        protocol: "openai-chat",
        baseURL: `http://localhost:${address.port}/v1`,
        credentials: {},
      })).resolves.toEqual([{ id: "local-default-request" }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("pins the validated address, sends the credential once, and sanitizes models", async () => {
    const credential = ["test", "credential"].join("-");
    const request = vi.fn(async (_url: URL, options: Record<string, any>) => {
      expect(options.pinnedAddress).toMatchObject({ address: "93.184.216.34", family: 4, loopback: false });
      expect(options.headers.Authorization).toBe(`Bearer ${credential}`);
      return response(200, JSON.stringify({
        data: [
          { id: "model-b", name: "Model B" },
          { id: "model-a" },
          { id: "model-b", name: "Duplicate" },
          { id: "" },
        ],
      }));
    });

    const models = await discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1/",
      credentials: { apiKey: credential },
      resolveHost: publicResolver,
      request,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].href).toBe("https://models.example/v1/models");
    expect(models).toEqual([
      { id: "model-b", name: "Model B" },
      { id: "model-a" },
    ]);
    expect(JSON.stringify(models)).not.toContain(credential);
  });

  it("preserves sanitized live capability metadata and exact curated fallback fields", async () => {
    const models = await discoverProviderModels({
      protocol: "openai-chat",
      providerId: "openai",
      baseURL: "https://api.openai.com/v1",
      credentials: {},
      resolveHost: publicResolver,
      now: () => 123,
      request: async () => response(200, JSON.stringify({
        data: [{
          id: "gpt-4o-mini",
          context_window: 96_000,
          architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          supported_parameters: ["tools"],
        }],
      })),
    });

    expect(models).toEqual([{
      id: "gpt-4o-mini",
      capabilities: expect.objectContaining({
        limits: { contextWindow: 96_000, maxOutput: 16_384 },
        modalities: { input: ["text"], output: ["text"] },
        provenance: expect.objectContaining({ source: "mixed", retrievedAt: 123 }),
      }),
    }]);
  });

  it("preserves explicit XPiki-compatible capability fields without inventing unsupported ones", async () => {
    const models = await discoverProviderModels({
      protocol: "openai-chat",
      providerId: "xpiki",
      baseURL: "https://api.xpiki.com/v1",
      credentials: {},
      resolveHost: publicResolver,
      now: () => 456,
      request: async () => response(200, JSON.stringify({
        data: [{
          id: "vendor/model",
          display_name: "Vendor model",
          limits: { max_input_tokens: 262_144 },
          max_output_tokens: 32_768,
          input_modalities: ["text", "image", "audio", "video", "file"],
          primary_output_modality: "text",
          capabilities: {
            supports_stream: true,
            supports_reasoning: true,
            supports_tools: false,
            supports_json_output: true,
          },
        }],
      })),
    });

    expect(models).toEqual([{
      id: "vendor/model",
      name: "Vendor model",
      capabilities: {
        limits: { contextWindow: 262_144, maxOutput: 32_768 },
        modalities: {
          input: ["text", "image", "audio", "video", "file"],
          output: ["text"],
        },
        features: { tools: false, reasoning: true, streaming: true },
        provenance: expect.objectContaining({ source: "live-provider", confidence: "high", retrievedAt: 456 }),
      },
    }]);
    expect(JSON.stringify(models)).not.toMatch(/supports_json_output/);
  });

  it("uses Anthropic's official model catalog contract and live limits", async () => {
    const credential = ["anthropic", "test", "key"].join("-");
    const request = vi.fn(async (url: URL, options: Record<string, any>) => {
      expect(url.pathname).toBe("/v1/models");
      expect(url.searchParams.get("limit")).toBe("1000");
      expect(options.headers).toMatchObject({
        "X-Api-Key": credential,
        "Anthropic-Version": "2023-06-01",
      });
      expect(options.headers).not.toHaveProperty("Authorization");
      return response(200, JSON.stringify({
        data: [{
          id: "claude-sonnet-4-5-20250929",
          display_name: "Claude Sonnet 4.5",
          max_input_tokens: 200_000,
          max_tokens: 64_000,
          capabilities: { thinking: { supported: true }, image_input: { supported: true } },
        }],
      }));
    });

    const models = await discoverProviderModels({
      protocol: "anthropic-messages",
      baseURL: "https://api.anthropic.com/v1",
      credentials: { apiKey: credential },
      resolveHost: publicResolver,
      request,
      now: () => 123,
    });

    expect(models[0]).toMatchObject({
      id: "claude-sonnet-4-5-20250929",
      name: "Claude Sonnet 4.5",
      capabilities: {
        limits: { contextWindow: 200_000, maxOutput: 64_000 },
        modalities: { input: ["text", "image"], output: ["text"] },
        features: { tools: true, reasoning: true, streaming: true },
      },
    });
  });

  it("uses Gemini's official model catalog contract without putting the key in the URL", async () => {
    const credential = ["gemini", "test", "key"].join("-");
    const request = vi.fn(async (url: URL, options: Record<string, any>) => {
      expect(url.pathname).toBe("/v1beta/models");
      expect(url.searchParams.get("pageSize")).toBe("1000");
      expect(url.href).not.toContain(credential);
      expect(options.headers["X-Goog-Api-Key"]).toBe(credential);
      return response(200, JSON.stringify({
        models: [{
          name: "models/gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 65_536,
          thinking: true,
        }],
      }));
    });

    const models = await discoverProviderModels({
      protocol: "google-generative-ai",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      credentials: { apiKey: credential },
      resolveHost: publicResolver,
      request,
      now: () => 123,
    });

    expect(models[0]).toMatchObject({
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      capabilities: {
        limits: { contextWindow: 1_048_576, maxOutput: 65_536 },
        modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
        features: { tools: true, reasoning: true, streaming: true },
      },
    });
  });

  it("never forwards credential-bearing public profile headers", async () => {
    const credential = ["private", "credential"].join("-");
    const request = vi.fn(async (_url: URL, options: Record<string, any>) => {
      expect(options.headers).toMatchObject({
        Authorization: `Bearer ${credential}`,
        "HTTP-Referer": "https://kyrei.local",
      });
      expect(options.headers).not.toHaveProperty("X-API-Key");
      expect(options.headers).not.toHaveProperty("Api-Key");
      expect(options.headers).not.toHaveProperty("Cookie");
      return response(200, JSON.stringify({ data: [] }));
    });
    await discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: { apiKey: credential },
      headers: {
        Authorization: "untrusted",
        "X-API-Key": "untrusted",
        "Api-Key": "untrusted",
        Cookie: "untrusted",
        "HTTP-Referer": "https://kyrei.local",
      },
      resolveHost: publicResolver,
      request,
    });
  });

  it("filters credential values echoed by a provider from discovered metadata", async () => {
    const credential = ["echoed", "credential", "value"].join("-");
    const longCredential = `long-secret-${"x".repeat(600)}`;
    const models = await discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: { apiKey: credential, privateKey: longCredential },
      resolveHost: publicResolver,
      request: async () => response(200, JSON.stringify({
        data: [
          { id: credential, name: "must be dropped" },
          { id: "safe-model", name: `name-${credential}` },
          { id: "safe-model-two", name: "Safe model" },
          { id: "safe-model-three", name: `${"p".repeat(500)}${longCredential}` },
        ],
      })),
    });
    expect(models).toEqual([
      { id: "safe-model" },
      { id: "safe-model-two", name: "Safe model" },
      { id: "safe-model-three" },
    ]);
    expect(JSON.stringify(models)).not.toContain(credential);
    expect(JSON.stringify(models)).not.toContain(longCredential.slice(0, 12));
  });

  it.each([
    ["http://127.0.0.1:11434/v1", { address: "127.0.0.1", family: 4 }],
    ["http://[::1]:11434/v1", { address: "::1", family: 6 }],
  ])("allows an explicitly configured loopback endpoint: %s", async (baseURL, pinnedAddress) => {
    const request = vi.fn(async () => response(200, JSON.stringify({ data: [{ id: "local-model" }] })));
    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL,
      credentials: {},
      request,
    })).resolves.toEqual([{ id: "local-model" }]);
    expect(request.mock.calls[0]?.[1].pinnedAddress).toMatchObject({ ...pinnedAddress, loopback: true });
  });

  it("requires a temporary opt-in for a trusted HTTPS benchmark-network hostname", async () => {
    const request = vi.fn(async (_url: URL, options: Record<string, any>) => {
      expect(options.pinnedAddress).toMatchObject({ address: "198.18.0.127", family: 4, loopback: false });
      return response(200, JSON.stringify({ data: [{ id: "benchmark-model" }] }));
    });
    const options = {
      protocol: "openai-chat",
      baseURL: "https://trusted.example/v1",
      credentials: {},
      resolveHost: benchmarkResolver,
      request,
    } as const;

    await expect(discoverProviderModels(options)).rejects.toMatchObject({
      code: "provider_discovery_benchmark_opt_in_required",
    });
    expect(request).not.toHaveBeenCalled();

    await expect(discoverProviderModels({ ...options, allowBenchmarkNetwork: true })).resolves.toEqual([
      { id: "benchmark-model" },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["https://198.18.0.1/v1", undefined],
    ["https://[::ffff:198.18.0.127]/v1", undefined],
    ["http://trusted.example/v1", benchmarkResolver],
    ["https://single-label/v1", benchmarkResolver],
    ["https://mixed.example/v1", async () => [
      { address: "198.18.0.127", family: 4 as const },
      { address: "10.0.0.2", family: 4 as const },
    ]],
  ])("does not widen the discovery SSRF boundary with benchmark opt-in: %s", async (baseURL, resolveHost) => {
    const request = vi.fn();
    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL,
      credentials: {},
      allowBenchmarkNetwork: true,
      ...(resolveHost ? { resolveHost } : {}),
      request,
    })).rejects.toMatchObject({ code: "provider_discovery_target_blocked" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["http://169.254.169.254/latest", undefined],
    ["http://192.0.2.10/v1", undefined],
    ["http://192.88.99.10/v1", undefined],
    ["http://198.18.0.1/v1", undefined],
    ["http://240.0.0.1/v1", undefined],
    ["https://mixed.example/v1", async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "10.0.0.2", family: 4 as const },
    ]],
    ["http://[::ffff:169.254.169.254]/v1", undefined],
    ["http://[64:ff9b::a9fe:a9fe]/v1", undefined],
    ["http://[2002:a9fe:a9fe::]/v1", undefined],
  ])("blocks metadata and non-LAN special targets: %s", async (baseURL, resolveHost) => {
    const request = vi.fn();
    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL,
      credentials: {},
      ...(resolveHost ? { resolveHost } : {}),
      request,
    })).rejects.toMatchObject({ code: "provider_discovery_target_blocked" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["http://10.0.0.2/v1", { address: "10.0.0.2", family: 4 }],
    ["http://192.168.1.50:11434/v1", { address: "192.168.1.50", family: 4 }],
    ["http://172.16.5.9/v1", { address: "172.16.5.9", family: 4 }],
  ])("allows user-configured RFC1918 LAN endpoints for local models: %s", async (baseURL, pinnedAddress) => {
    const request = vi.fn(async () => response(200, JSON.stringify({ data: [{ id: "lan-model" }] })));
    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL,
      credentials: {},
      request,
    })).resolves.toEqual([{ id: "lan-model" }]);
    expect(request.mock.calls[0]?.[1].pinnedAddress).toMatchObject({
      ...pinnedAddress,
      privateLan: true,
      loopback: false,
    });
  });

  it("allows a public HTTPS literal IP with normal TLS pinning", async () => {
    const request = vi.fn(async () => response(200, JSON.stringify({ data: [{ id: "public-ip-model" }] })));
    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://93.184.216.34/v1",
      credentials: {},
      request,
    })).resolves.toEqual([{ id: "public-ip-model" }]);
    expect(request.mock.calls[0]?.[1].pinnedAddress).toMatchObject({
      address: "93.184.216.34",
      family: 4,
      loopback: false,
      privateLan: false,
    });
  });

  it("allows HTTPS hostname that resolves only to RFC1918", async () => {
    const request = vi.fn(async () => response(200, JSON.stringify({ data: [{ id: "home-nas" }] })));
    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://ollama.home/v1",
      credentials: {},
      resolveHost: async () => [{ address: "192.168.1.2", family: 4 as const }],
      request,
    })).resolves.toEqual([{ id: "home-nas" }]);
  });

  it("requires HTTPS for public non-loopback discovery targets", async () => {
    const request = vi.fn(async () => response(200, JSON.stringify({ data: [] })));
    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "http://models.example/v1",
      credentials: { apiKey: ["do", "not", "send"].join("-") },
      resolveHost: publicResolver,
      request,
    })).rejects.toMatchObject({ code: "provider_discovery_target_blocked" });
    expect(request).not.toHaveBeenCalled();
  });

  it("allows a public HTTP literal IP only with an exact-origin insecure opt-in", async () => {
    const request = vi.fn(async () => response(200, JSON.stringify({ data: [{ id: "public-http-ip" }] })));
    const options = {
      protocol: "openai-chat",
      baseURL: "http://93.184.216.34:8080/v1",
      credentials: {},
      request,
    } as const;

    await expect(discoverProviderModels(options)).rejects.toMatchObject({ code: "provider_discovery_target_blocked" });
    expect(request).not.toHaveBeenCalled();

    await expect(discoverProviderModels({
      ...options,
      allowInsecureHttpOrigins: ["http://93.184.216.34:8080"],
    })).resolves.toEqual([{ id: "public-http-ip" }]);
    expect(request).toHaveBeenCalledTimes(1);

    await expect(discoverProviderModels({
      ...options,
      allowInsecureHttpOrigins: ["http://93.184.216.34:9090"],
    })).rejects.toMatchObject({ code: "provider_discovery_target_blocked" });
  });

  it.each([
    [302, "provider_discovery_redirect_blocked"],
    [401, "provider_discovery_unauthorized"],
    [403, "provider_discovery_unauthorized"],
    [429, "provider_discovery_rate_limited"],
    [500, "provider_discovery_unavailable"],
  ])("maps HTTP %s to %s without returning the upstream body", async (status, code) => {
    const credential = ["never", "echo"].join("-");
    const request = async () => response(status, `upstream-${credential}`);
    const promise = discoverProviderModels({
      protocol: "openai-responses",
      baseURL: "https://models.example/v1",
      credentials: { apiKey: credential },
      resolveHost: publicResolver,
      request,
    });
    await expect(promise).rejects.toMatchObject({ code });
    await expect(promise).rejects.not.toThrow(credential);
  });

  it("follows a bounded same-origin redirect and revalidates each hop", async () => {
    const request = vi.fn(async (url: URL) => {
      if (url.pathname === "/v1/models") {
        return response(302, "", { location: "https://models.example/v1/catalog" });
      }
      if (url.pathname === "/v1/catalog") {
        return response(200, JSON.stringify({ data: [{ id: "redirected-model" }] }));
      }
      return response(404, "");
    });

    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: { apiKey: "redirect-secret" },
      resolveHost: publicResolver,
      request,
    })).resolves.toEqual([{ id: "redirected-model" }]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer redirect-secret");
    expect(request.mock.calls[1]?.[1].headers.Authorization).toBe("Bearer redirect-secret");
  });

  it("blocks cross-origin redirects before forwarding credentials to a new host", async () => {
    const request = vi.fn(async () => response(302, "", { location: "https://evil.example/v1/models" }));

    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: { apiKey: "never-forward" },
      resolveHost: publicResolver,
      request,
    })).rejects.toMatchObject({ code: "provider_discovery_redirect_blocked" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("destroys response bodies rejected before consumption", async () => {
    const unauthorizedBody = { destroy: vi.fn() };
    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: {},
      resolveHost: publicResolver,
      request: async () => ({ status: 401, headers: {}, body: unauthorizedBody }),
    })).rejects.toMatchObject({ code: "provider_discovery_unauthorized" });
    expect(unauthorizedBody.destroy).toHaveBeenCalledTimes(1);

    const oversizedBody = { destroy: vi.fn() };
    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: {},
      resolveHost: publicResolver,
      maxBytes: 10,
      request: async () => ({ status: 200, headers: { "content-length": "100" }, body: oversizedBody }),
    })).rejects.toMatchObject({ code: "provider_discovery_response_too_large" });
    expect(oversizedBody.destroy).toHaveBeenCalledTimes(1);
  });

  it("bounds model count and response size", async () => {
    const request = async () => response(200, JSON.stringify({
      data: Array.from({ length: 5 }, (_, index) => ({ id: `model-${index}` })),
    }));
    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: {},
      resolveHost: publicResolver,
      request,
      maxModels: 2,
    })).resolves.toHaveLength(2);

    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: {},
      resolveHost: publicResolver,
      request,
      maxBytes: 10,
    })).rejects.toMatchObject({ code: "provider_discovery_response_too_large" });
  });

  it("uses stable errors for unsupported protocols, invalid JSON, and timeout", async () => {
    await expect(discoverProviderModels({
      protocol: "amazon-bedrock",
      baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
      credentials: {},
    })).rejects.toMatchObject({ code: "provider_discovery_unsupported" });

    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: {},
      resolveHost: publicResolver,
      request: async () => response(200, "not-json"),
    })).rejects.toMatchObject({ code: "provider_discovery_invalid_response" });

    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: {},
      resolveHost: publicResolver,
      timeoutMs: 5,
      request: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    })).rejects.toMatchObject({ code: "provider_discovery_timeout" });
  });

  it("does not start an outbound request when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => response(200, JSON.stringify({ data: [] })));
    const resolveHost = vi.fn(publicResolver);
    await expect(discoverProviderModels({
      protocol: "openai-chat",
      baseURL: "https://models.example/v1",
      credentials: {},
      signal: controller.signal,
      resolveHost,
      request,
    })).rejects.toMatchObject({ code: "provider_discovery_unavailable" });
    expect(resolveHost).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("exposes only the stable code as the error message", () => {
    const error = new ProviderDiscoveryError("provider_discovery_unavailable");
    expect(error.message).toBe("provider_discovery_unavailable");
  });
});
