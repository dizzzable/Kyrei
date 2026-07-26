import { afterEach, describe, it, expect, vi } from "vitest";
import {
  classifyProviderFailure,
  isAuthFailure,
  isDefiniteAuthFailure,
  isNetworkError,
  isRetryable,
  isRateLimit,
  isSoftAuthFailure,
  isToolUnsupported,
  isServerError,
  retryAfterMsOf,
} from "./errors.js";
import { resolve, isLocalBaseURL, registerModel, canonicalModelId } from "./registry.js";
import { openStream, type StreamLike } from "./open-stream.js";
import { buildModel, buildProviderOptions, hasProviderCredentials } from "./build.js";

afterEach(() => vi.unstubAllEnvs());

describe("buildProviderOptions (reasoning/effort)", () => {
  it("emits nothing when no params or reasoning disabled", () => {
    expect(buildProviderOptions("openai-chat", undefined)).toBeUndefined();
    expect(buildProviderOptions("openai-chat", {})).toBeUndefined();
    expect(buildProviderOptions("openai-chat", { effort: "off" })).toBeUndefined();
    expect(buildProviderOptions("openai-chat", { effort: "none" })).toBeUndefined();
  });
  it("maps explicit effort to protocol-specific providerOptions", () => {
    expect(buildProviderOptions("openai-chat", { effort: "high" })).toEqual({ kyrei: { reasoningEffort: "high" } });
    expect(buildProviderOptions("openai-responses", { effort: "low" })).toEqual({ openai: { reasoningEffort: "low" } });
  });
  it("uses an explicit thinking-toggle dialect for compatible endpoints such as Z.AI", () => {
    expect(buildProviderOptions("openai-chat", { effort: "high" }, "thinking-toggle")).toEqual({
      kyrei: { thinking: { type: "enabled" } },
    });
    expect(buildProviderOptions("openai-chat", { effort: "off" }, "thinking-toggle")).toEqual({
      kyrei: { thinking: { type: "disabled" } },
    });
    expect(buildProviderOptions("openai-chat", { fast: true }, "thinking-toggle")).toEqual({
      kyrei: { thinking: { type: "disabled" } },
    });
  });
  it("serializes provider-specific preserved thinking without guessing from a model name", () => {
    expect(buildProviderOptions("openai-chat", { effort: "high" }, "zai-thinking-preserved")).toEqual({
      kyrei: { thinking: { type: "enabled", clear_thinking: false } },
    });
    expect(buildProviderOptions("openai-chat", { effort: "off" }, "zai-thinking-preserved")).toEqual({
      kyrei: { thinking: { type: "disabled" } },
    });
    expect(buildProviderOptions("openai-chat", { effort: "high" }, "kimi-thinking-preserved")).toEqual({
      kyrei: { thinking: { type: "enabled", keep: "all" } },
    });
    expect(buildProviderOptions("openai-chat", { effort: "high" }, "kimi-k3-reasoning-max")).toEqual({
      kyrei: { reasoningEffort: "max" },
    });
    expect(buildProviderOptions("openai-chat", { effort: "max" }, "kimi-k3-reasoning-max")).toEqual({
      kyrei: { reasoningEffort: "max" },
    });
    expect(buildProviderOptions("openai-chat", { effort: "off" }, "kimi-k3-reasoning-max")).toEqual({
      kyrei: { reasoningEffort: "max" },
    });
    expect(buildProviderOptions("openai-chat", { fast: true }, "kimi-k3-reasoning-max")).toEqual({
      kyrei: { reasoningEffort: "max" },
    });
  });
  it("preserves xhigh for responses and clamps UI-only max elsewhere", () => {
    expect(buildProviderOptions("openai-chat", { effort: "xhigh" })).toEqual({ kyrei: { reasoningEffort: "high" } });
    expect(buildProviderOptions("openai-chat", { effort: "max" })).toEqual({ kyrei: { reasoningEffort: "high" } });
    expect(buildProviderOptions("openai-responses", { effort: "xhigh" })).toEqual({ openai: { reasoningEffort: "xhigh" } });
    expect(buildProviderOptions("openai-responses", { effort: "max" })).toEqual({ openai: { reasoningEffort: "xhigh" } });
  });
  it("keeps max distinct from xhigh on providers that support both", () => {
    // Anthropic and Bedrock expose max as its own level above xhigh; collapsing
    // it silently downgraded every request that asked for it.
    expect(buildProviderOptions("anthropic-messages", { effort: "max" }, undefined, "claude-opus-5")).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
    });
    expect(buildProviderOptions("anthropic-messages", { effort: "xhigh" }, undefined, "claude-opus-5")).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "xhigh" },
    });
    expect(buildProviderOptions("amazon-bedrock", { effort: "max" }, undefined, "anthropic.claude-opus-5"))
      .toMatchObject({ bedrock: { reasoningConfig: { maxReasoningEffort: "max" } } });
  });
  it("derives from fast/reasoning when no explicit effort", () => {
    expect(buildProviderOptions("openai-chat", { fast: true })).toEqual({ kyrei: { reasoningEffort: "minimal" } });
    expect(buildProviderOptions("openai-chat", { reasoning: true })).toEqual({ kyrei: { reasoningEffort: "medium" } });
    expect(buildProviderOptions("openai-responses", { fast: true })).toEqual({
      openai: { reasoningEffort: "minimal", serviceTier: "priority" },
    });
  });
  it("explicit effort wins over fast", () => {
    expect(buildProviderOptions("openai-chat", { effort: "high", fast: true })).toEqual({ kyrei: { reasoningEffort: "high" } });
  });
  it("maps thinking for Anthropic, Google, Vertex, and Bedrock", () => {
    // budgetTokens is a hard 400 on Opus 4.7+/Sonnet 5/Fable 5; adaptive+effort
    // is the current contract and the default for unknown ids.
    expect(buildProviderOptions("anthropic-messages", { effort: "high" }, undefined, "claude-opus-5")).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
    });
    expect(buildProviderOptions("google-generative-ai", { effort: "medium" })).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "medium",
          thinkingBudget: 4_096,
          includeThoughts: true,
        },
      },
    });
    expect(buildProviderOptions("google-vertex", { effort: "low" })).toMatchObject({
      google: { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } },
      vertex: { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } },
    });
    const legacyBedrock = buildProviderOptions(
      "amazon-bedrock",
      { effort: "high" },
      undefined,
      "anthropic.claude-sonnet-4-5",
    ) as { bedrock: { reasoningConfig: Record<string, unknown> } };
    expect(legacyBedrock.bedrock.reasoningConfig).toMatchObject({
      type: "enabled",
      budgetTokens: 16_000,
    });
    // `effort` ERRORS on Sonnet 4.5 / Haiku 4.5 — this assertion used to pin
    // the opposite, while the very next test's comment said effort is not sent.
    // The anthropic-messages branch already omitted it for the same reason.
    expect(legacyBedrock.bedrock.reasoningConfig).not.toHaveProperty("maxReasoningEffort");
  });
  it("keeps the legacy budgetTokens contract for pre-4.6 Claude models", () => {
    // Sonnet 4.5 / Haiku 4.5 / Opus 4.5 and older still require a token budget
    // and reject the effort parameter, so neither adaptive nor effort is sent.
    for (const id of ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1", "claude-3-haiku-20240307"]) {
      expect(buildProviderOptions("anthropic-messages", { effort: "high" }, undefined, id)).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 16_000 } },
      });
    }
  });
  it("caps xhigh to high on the 4.6 family, which predates xhigh", () => {
    expect(buildProviderOptions("anthropic-messages", { effort: "xhigh" }, undefined, "claude-opus-4-6")).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
    });
    expect(buildProviderOptions("anthropic-messages", { effort: "max" }, undefined, "claude-sonnet-4-6")).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "max" },
    });
  });
  it("normalizes Bedrock prefixes and Vertex version suffixes when classifying", () => {
    expect(buildProviderOptions("anthropic-messages", { effort: "low" }, undefined, "claude-opus-4-5@20251101"))
      .toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 2_048 } } });
    expect(buildProviderOptions("anthropic-messages", { effort: "low" }, undefined, "anthropic.claude-sonnet-5"))
      .toEqual({ anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" } });
  });

  it("classifies Bedrock cross-region profiles and Vertex resource paths", () => {
    // Regression: only a single leading prefix segment was stripped, so
    // `us.anthropic.*` — the standard Bedrock inference-profile form — and full
    // Vertex resource paths fell through to "adaptive" and were sent the exact
    // budgetTokens-free payload those pre-4.6 models reject.
    const legacy = { anthropic: { thinking: { type: "enabled", budgetTokens: 2_048 } } };
    for (const id of [
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "eu.anthropic.claude-3-5-sonnet-20240620-v1:0",
      "apac.anthropic.claude-haiku-4-5",
      "projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5",
      "claude-instant-1.2",
    ]) {
      expect(buildProviderOptions("anthropic-messages", { effort: "low" }, undefined, id)).toEqual(legacy);
    }
    expect(buildProviderOptions("anthropic-messages", { effort: "low" }, undefined, "us.anthropic.claude-sonnet-5-v1:0"))
      .toEqual({ anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" } });
  });
  it("maps minimal to low for Anthropic, whose effort enum has no minimal", () => {
    expect(buildProviderOptions("anthropic-messages", { fast: true }, undefined, "claude-opus-5")).toEqual({
      anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
    });
  });
});

describe("native provider builders", () => {
  it("constructs every supported protocol without routing through AI Gateway", () => {
    const compatible = buildModel({
      protocol: "openai-chat",
      baseURL: "https://custom.example/v1",
      apiKey: "custom-key",
      model: "custom-model",
    });
    const openai = buildModel({
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      apiKey: "openai-key",
      model: "gpt-5.4",
    });
    const anthropic = buildModel({
      protocol: "anthropic-messages",
      baseURL: "https://api.anthropic.com/v1",
      apiKey: "anthropic-key",
      model: "claude-sonnet-4-5",
    });
    const google = buildModel({
      protocol: "google-generative-ai",
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "google-key",
      model: "gemini-2.5-pro",
    });
    const bedrock = buildModel({
      protocol: "amazon-bedrock",
      baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKey: "",
      credentials: { region: "us-east-1", accessKeyId: "AKIA_TEST", secretAccessKey: "secret" },
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    });
    const vertex = buildModel({
      protocol: "google-vertex",
      baseURL: "https://aiplatform.googleapis.com",
      apiKey: "",
      credentials: {
        project: "kyrei-test",
        location: "us-central1",
        clientEmail: "kyrei@kyrei-test.iam.gserviceaccount.com",
        privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
      },
      model: "gemini-2.5-pro",
    });
    expect(compatible.provider).toContain("kyrei");
    expect(openai.provider).toContain("openai");
    expect(anthropic.provider).toContain("anthropic");
    expect(google.provider).toContain("google");
    expect(bedrock.provider).toContain("bedrock");
    expect(vertex.provider).toContain("google.vertex");
  });

  it("does not invent OpenAI-compatible authorization and preserves explicit transport options", async () => {
    const customFetch = vi.fn() as unknown as typeof fetch;
    const noKey = buildModel({
      protocol: "openai-chat",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKey: "",
      model: "local-model",
      fetch: customFetch,
    }) as unknown as {
      config: {
        fetch?: typeof fetch;
        headers: () => Record<string, string | undefined>;
      };
    };
    const keyed = buildModel({
      protocol: "openai-chat",
      baseURL: "https://custom.example/v1",
      apiKey: "custom-key",
      model: "remote-model",
    }) as unknown as {
      config: { headers: () => Record<string, string | undefined> };
    };

    const noKeyHeaders = Object.fromEntries(
      Object.entries(await noKey.config.headers()).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const keyedHeaders = Object.fromEntries(
      Object.entries(await keyed.config.headers()).map(([name, value]) => [name.toLowerCase(), value]),
    );

    expect(noKey.config.fetch).toBe(customFetch);
    expect(noKeyHeaders).not.toHaveProperty("authorization");
    expect(keyedHeaders.authorization).toBe("Bearer custom-key");
  });

  it("serializes the selected compatible reasoning dialect into the outgoing request", async () => {
    const model = buildModel({
      protocol: "openai-chat",
      baseURL: "https://custom.example/v1",
      apiKey: "custom-key",
      model: "glm-5",
    }) as unknown as {
      getArgs: (options: {
        prompt: unknown[];
        providerOptions?: Record<string, Record<string, unknown>>;
      }) => Promise<{ args: Record<string, unknown> }>;
    };

    const { args } = await model.getArgs({
      prompt: [{ role: "user", content: [{ type: "text", text: "diagnostic" }] }],
      providerOptions: buildProviderOptions("openai-chat", { effort: "high" }, "thinking-toggle"),
    });

    expect(args).toMatchObject({ thinking: { type: "enabled" } });
    expect(args.reasoning_effort).toBeUndefined();
  });

  it("passes preserved-thinking fields through unchanged for documented GLM and Kimi endpoints", async () => {
    const model = buildModel({
      protocol: "openai-chat",
      baseURL: "https://custom.example/v1",
      apiKey: "custom-key",
      model: "reasoning-model",
    }) as unknown as {
      getArgs: (options: {
        prompt: unknown[];
        providerOptions?: Record<string, Record<string, unknown>>;
      }) => Promise<{ args: Record<string, unknown> }>;
    };
    const prompt = [{ role: "user", content: [{ type: "text", text: "diagnostic" }] }];

    const zai = await model.getArgs({
      prompt,
      providerOptions: buildProviderOptions("openai-chat", { effort: "high" }, "zai-thinking-preserved"),
    });
    const kimi = await model.getArgs({
      prompt,
      providerOptions: buildProviderOptions("openai-chat", { effort: "high" }, "kimi-thinking-preserved"),
    });
    const kimiK3 = await model.getArgs({
      prompt,
      providerOptions: buildProviderOptions("openai-chat", { effort: "high" }, "kimi-k3-reasoning-max"),
    });

    expect(zai.args).toMatchObject({ thinking: { type: "enabled", clear_thinking: false } });
    expect(kimi.args).toMatchObject({ thinking: { type: "enabled", keep: "all" } });
    expect(kimiK3.args).toMatchObject({ reasoning_effort: "max" });
  });

  it("serializes the fast OpenAI Responses path as a priority service tier", async () => {
    const model = buildModel({
      protocol: "openai-responses",
      baseURL: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-5.6-sol",
    }) as unknown as {
      getArgs: (options: {
        prompt: unknown[];
        providerOptions?: Record<string, Record<string, unknown>>;
      }) => Promise<{ args: Record<string, unknown> }>;
    };

    const { args } = await model.getArgs({
      prompt: [{ role: "user", content: [{ type: "text", text: "diagnostic" }] }],
      providerOptions: buildProviderOptions("openai-responses", { fast: true }),
    });

    expect(args).toMatchObject({
      reasoning: { effort: "minimal" },
      service_tier: "priority",
    });
  });

  it("requires protocol-complete credential sets", () => {
    expect(hasProviderCredentials("google-generative-ai", { apiKey: "key" })).toBe(true);
    expect(hasProviderCredentials("amazon-bedrock", { apiKey: "bearer" })).toBe(false);
    expect(hasProviderCredentials("amazon-bedrock", { region: "us-east-1", apiKey: "bearer" })).toBe(true);
    expect(hasProviderCredentials("amazon-bedrock", { region: "us-east-1", accessKeyId: "id" })).toBe(false);
    expect(hasProviderCredentials("amazon-bedrock", { region: "us-east-1", accessKeyId: "id", secretAccessKey: "secret" })).toBe(true);
    expect(hasProviderCredentials("google-vertex", { project: "p", location: "l", clientEmail: "e", privateKey: "k" })).toBe(true);
    expect(hasProviderCredentials("google-vertex", { project: "p", location: "l" })).toBe(false);
  });

  it("lets native SDKs resolve environment keys instead of injecting a placeholder", async () => {
    vi.stubEnv("OPENAI_API_KEY", "env-openai");
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "env-google");
    const cases = [
      {
        model: buildModel({ protocol: "openai-responses", baseURL: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" }),
        header: "authorization",
        value: "Bearer env-openai",
      },
      {
        model: buildModel({ protocol: "anthropic-messages", baseURL: "https://api.anthropic.com/v1", apiKey: "", model: "claude-sonnet" }),
        header: "x-api-key",
        value: "env-anthropic",
      },
      {
        model: buildModel({ protocol: "google-generative-ai", baseURL: "https://generativelanguage.googleapis.com/v1beta", apiKey: "", model: "gemini-2.5-pro" }),
        header: "x-goog-api-key",
        value: "env-google",
      },
    ];

    for (const item of cases) {
      const model = item.model as unknown as { config: { headers: () => Promise<Record<string, string>> | Record<string, string> } };
      const headers = await model.config.headers();
      expect(headers[item.header]).toBe(item.value);
    }
  });
});

describe("errors classification", () => {
  it("rate limit / server / retryable", () => {
    expect(isRateLimit({ statusCode: 429 })).toBe(true);
    expect(isServerError({ status: 503 })).toBe(true);
    expect(isRetryable({ statusCode: 500 })).toBe(true);
    expect(isRetryable({ message: "fetch failed" })).toBe(true);
    expect(isRetryable({ statusCode: 400, message: "bad" })).toBe(false);
    expect(isAuthFailure({ statusCode: 401 })).toBe(true);
    expect(isAuthFailure({ status: 403 })).toBe(true);
    expect(isAuthFailure({ statusCode: 400 })).toBe(false);
  });
  it("separates network noise from definite vs soft auth for anti-false-ban", () => {
    expect(isNetworkError({ code: "ECONNRESET", message: "socket hang up" })).toBe(true);
    expect(isNetworkError({ message: "fetch failed" })).toBe(true);
    expect(isNetworkError({ statusCode: 503, message: "network" })).toBe(false);
    expect(classifyProviderFailure({ code: "ETIMEDOUT" })).toBe("network");
    expect(isDefiniteAuthFailure({ statusCode: 401 })).toBe(false);
    expect(isDefiniteAuthFailure({ statusCode: 401, message: "Invalid API key" })).toBe(true);
    expect(isDefiniteAuthFailure({ statusCode: 403, message: "Invalid API key" })).toBe(true);
    expect(isSoftAuthFailure({ statusCode: 403, message: "cloudflare ray id blocked" })).toBe(true);
    expect(isDefiniteAuthFailure({ statusCode: 403, message: "cloudflare ray id blocked" })).toBe(false);
    expect(isRetryable({ statusCode: 403, message: "edge blocked" })).toBe(true);
    expect(classifyProviderFailure({ statusCode: 403 })).toBe("auth_soft");
    expect(classifyProviderFailure({ statusCode: 401 })).toBe("auth_uncertain");
    expect(classifyProviderFailure({ statusCode: 401, message: "Invalid API key" })).toBe("auth_definite");
    expect(classifyProviderFailure({ statusCode: 429 })).toBe("rate_limit");
  });
  it("tool unsupported detection", () => {
    expect(isToolUnsupported({ statusCode: 400, message: "tools are not supported" })).toBe(true);
    expect(isToolUnsupported({ statusCode: 404, message: "unknown parameter: tool_choice" })).toBe(true);
    expect(isToolUnsupported({ statusCode: 500, message: "tool" })).toBe(false);
    expect(isToolUnsupported({ statusCode: 400, message: "rate" })).toBe(false);
  });
  it("extracts only a bounded Retry-After duration", () => {
    expect(retryAfterMsOf({ response: { headers: { "Retry-After": "2.5", Authorization: "secret" } } })).toBe(2_500);
    expect(retryAfterMsOf({ retryAfterMs: 500 })).toBe(500);
    expect(retryAfterMsOf({ headers: { "Retry-After": "999999" } })).toBe(24 * 60 * 60_000);
  });
});

describe("registry.resolve", () => {
  it("resolves known model ids and treats unknown ids literally", () => {
    expect(resolve("default").id).toBe("default");
    expect(resolve("llama3.1:8b").provider).toBe("ollama");
    const custom = resolve("my-model", { baseURL: "http://localhost:11434/v1", id: "my-model" });
    expect(custom.provider).toBe("custom");
    expect(custom.baseURL).toBe("http://localhost:11434/v1");
  });
  it("does not attach canonical limits to a proxy that reuses a known model id", () => {
    const canonical = resolve("gpt-4o-mini", {
      baseURL: "https://api.openai.com/v1/",
      protocol: "openai-chat",
      provider: "configured-openai",
    });
    expect(canonical.limits).toEqual({ contextWindow: 128_000, maxOutput: 16_384 });

    const proxy = resolve("gpt-4o-mini", {
      baseURL: "https://proxy.example/v1",
      protocol: "openai-chat",
      provider: "configured-openai",
    });
    expect(proxy.limits).toEqual({});

    const wrongProtocol = resolve("gpt-4o-mini", {
      baseURL: "https://api.openai.com/v1",
      protocol: "anthropic-messages",
      provider: "configured-openai",
    });
    expect(wrongProtocol.limits).toEqual({});
  });
  it("preserves partial limits without inventing a missing context window", () => {
    registerModel({
      id: "output-only-test-model",
      provider: "test-provider",
      baseURL: "https://partial.example/v1",
      limits: { maxOutput: 2_048 },
      cost: { inputPerM: 0, outputPerM: 0 },
      caps: { tools: false, reasoning: false, streaming: true, vision: false },
    });
    expect(resolve("output-only-test-model", {
      baseURL: "https://partial.example/v1",
      protocol: "openai-chat",
    }).limits).toEqual({ maxOutput: 2_048 });
  });
  it("detects local base URLs", () => {
    expect(isLocalBaseURL("http://localhost:11434/v1")).toBe(true);
    expect(isLocalBaseURL("https://api.openai.com/v1")).toBe(false);
  });
});

// ── openStream fallbacks ──────────────────────────────────────────────
function streamOf(parts: unknown[]): StreamLike {
  return {
    stream: (async function* () {
      for (const p of parts) yield p;
    })(),
    responseMessages: Promise.resolve([]),
  };
}
async function collect(s: StreamLike): Promise<string[]> {
  const types: string[] = [];
  for await (const p of s.stream) types.push((p as { type: string }).type);
  return types;
}

describe("openStream — no-tools fallback", () => {
  it("retries with regular tools when only forced tool choice is rejected", async () => {
    const calls: Array<{ c: number; useTools: boolean; useForcedToolChoice?: boolean }> = [];
    const start = (c: number, useTools: boolean, useForcedToolChoice?: boolean): StreamLike => {
      calls.push({ c, useTools, useForcedToolChoice });
      if (useForcedToolChoice !== false) {
        return streamOf([{ type: "error", error: { statusCode: 400, message: "unknown parameter: tool_choice" } }]);
      }
      return streamOf([{ type: "text-delta", text: "tools retained" }, { type: "finish" }]);
    };

    const stream = await openStream(1, true, start);
    expect(await collect(stream)).toEqual(["text-delta", "finish"]);
    expect(calls).toEqual([
      { c: 0, useTools: true, useForcedToolChoice: true },
      { c: 0, useTools: true, useForcedToolChoice: false },
    ]);
  });

  it("retries the same candidate without tools on tool-unsupported error", async () => {
    let calls: Array<{ c: number; useTools: boolean }> = [];
    const start = (c: number, useTools: boolean): StreamLike => {
      calls.push({ c, useTools });
      if (useTools) return streamOf([{ type: "error", error: { statusCode: 400, message: "tools not supported" } }]);
      return streamOf([{ type: "text-delta", text: "ok" }, { type: "finish" }]);
    };
    const s = await openStream(1, true, start);
    const types = await collect(s);
    expect(types).toEqual(["text-delta", "finish"]);
    expect(calls).toEqual([
      { c: 0, useTools: true },
      { c: 0, useTools: false },
    ]);
  });
});

describe("openStream — provider fallback", () => {
  it("moves to the next candidate on a retryable error", async () => {
    const start = (c: number): StreamLike => {
      if (c === 0) return streamOf([{ type: "error", error: { statusCode: 503, message: "unavailable" } }]);
      return streamOf([{ type: "text-delta", text: "hi" }, { type: "finish" }]);
    };
    const s = await openStream(2, false, start);
    expect(await collect(s)).toEqual(["text-delta", "finish"]);
  });

  it("surfaces a non-retryable error on the only candidate (head preserved)", async () => {
    const start = (): StreamLike => streamOf([{ type: "error", error: { statusCode: 401, message: "bad key" } }]);
    const s = await openStream(1, false, start);
    expect(await collect(s)).toEqual(["error"]);
  });

  it("uses a healthy first candidate and preserves its first part", async () => {
    const start = (): StreamLike => streamOf([{ type: "text-delta", text: "a" }, { type: "finish" }]);
    const s = await openStream(2, false, start);
    expect(await collect(s)).toEqual(["text-delta", "finish"]);
  });
});

describe("platform-hosted Claude resolves to a real price and window", () => {
  // Bedrock/Vertex serve the same models under namespaced ids on different
  // endpoints, so neither the direct lookup nor `isCanonicalHint` matched and
  // every such deployment got `cost {0,0}` and unknown limits — turning every
  // dollar budget into a no-op and leaving context accounting without a window.
  it.each([
    ["anthropic.claude-opus-4-5-v1:0", "amazon-bedrock"],
    ["anthropic.claude-sonnet-4-5-20250929-v1:0", "amazon-bedrock"],
    ["claude-opus-4-5@20250101", "google-vertex"],
  ])("prices %s on %s", (id, protocol) => {
    const entry = resolve(id, { protocol, baseURL: "https://bedrock-runtime.us-east-1.amazonaws.com" });
    expect(entry.cost.inputPerM).toBeGreaterThan(0);
    expect(entry.cost.outputPerM).toBeGreaterThan(0);
    expect(entry.limits.contextWindow).toBeGreaterThan(0);
    // The caller's own id is preserved — only the pricing lookup is normalized.
    expect(entry.id).toBe(id);
  });

  it("leaves a genuinely unknown model unpriced", () => {
    const entry = resolve("anthropic.some-future-model-v1:0", { protocol: "amazon-bedrock" });
    expect(entry.cost.inputPerM).toBe(0);
  });

  it("does not let the platform path bypass the canonical check for direct Anthropic", () => {
    // A proxy claiming anthropic-messages on a foreign endpoint must still miss.
    const entry = resolve("claude-opus-5", { protocol: "anthropic-messages", baseURL: "https://proxy.example.test/v1" });
    expect(entry.cost.inputPerM).toBe(0);
  });

  it("normalizes ids without inventing one", () => {
    expect(canonicalModelId("anthropic.claude-opus-4-5-v1:0")).toBe("claude-opus-4-5");
    expect(canonicalModelId("claude-opus-4-5@20250101")).toBe("claude-opus-4-5");
    expect(canonicalModelId("gpt-5")).toBe("gpt-5");
  });
});
