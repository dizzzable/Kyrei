import { describe, expect, it } from "vitest";

import {
  curatedModelCapabilities,
  extractLiveModelCapabilities,
  normalizeStoredModelCapabilities,
  resolveModelCapabilities,
} from "../core/model-capabilities.js";

describe("model capability metadata", () => {
  it("prefers explicit live provider fields over exact curated values field-by-field", () => {
    const live = extractLiveModelCapabilities({
      id: "gpt-4o-mini",
      context_window: 96_000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      supported_parameters: ["tools"],
    }, { retrievedAt: 123 });
    const resolved = resolveModelCapabilities({
      providerId: "openai",
      modelId: "gpt-4o-mini",
      live,
    });

    expect(resolved).toMatchObject({
      limits: { contextWindow: 96_000, maxOutput: 16_384 },
      modalities: { input: ["text"], output: ["text"] },
      features: { tools: true, reasoning: false, streaming: true },
      provenance: {
        source: "mixed",
        confidence: "medium",
        retrievedAt: 123,
        fields: {
          contextWindow: { source: "live-provider", confidence: "high" },
          maxOutput: { source: "curated", confidence: "high" },
          tools: { source: "live-provider", confidence: "medium" },
        },
      },
    });
  });

  it("uses only exact curated ids and never guesses an unknown model's 32k context", () => {
    expect(curatedModelCapabilities({ providerId: "openai", modelId: "gpt-4o-mini" })?.limits).toEqual({
      contextWindow: 128_000,
      maxOutput: 16_384,
    });
    expect(resolveModelCapabilities({ providerId: "openai", modelId: "gpt-4o-mini-custom" })).toEqual({
      provenance: { source: "unknown", confidence: "unknown", fields: {} },
    });
    expect(resolveModelCapabilities({
      providerId: "openai",
      baseURL: "https://api.xpiki.com/v1",
      modelId: "gpt-4o-mini",
    })).toEqual({ provenance: { source: "unknown", confidence: "unknown", fields: {} } });
    expect(resolveModelCapabilities({ providerId: "custom", modelId: "totally-unknown" }).limits).toBeUndefined();
  });

  it("normalizes current live contracts from Gemini, Anthropic and OpenRouter", () => {
    expect(extractLiveModelCapabilities({
      inputTokenLimit: 1_048_576,
      outputTokenLimit: 65_536,
      thinking: true,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    })).toMatchObject({
      limits: { contextWindow: 1_048_576, maxOutput: 65_536 },
      features: { reasoning: true, streaming: true },
    });

    expect(extractLiveModelCapabilities({
      max_input_tokens: 200_000,
      max_tokens: 64_000,
      capabilities: { image_input: { supported: true }, thinking: { supported: false } },
    })).toMatchObject({
      limits: { contextWindow: 200_000, maxOutput: 64_000 },
      modalities: { input: ["text", "image"] },
      features: { reasoning: false },
    });

    expect(extractLiveModelCapabilities({
      context_length: 131_072,
      top_provider: { max_completion_tokens: 16_384 },
      architecture: { input_modalities: ["TEXT", "image", "file"], output_modalities: ["text"] },
      supported_parameters: ["tool_choice", "reasoning_effort"],
    })).toMatchObject({
      limits: { contextWindow: 131_072, maxOutput: 16_384 },
      modalities: { input: ["text", "image", "file"], output: ["text"] },
      features: { tools: true, reasoning: true },
    });
  });

  it("normalizes only explicit XPiki-style limits, modalities, and nested support flags", () => {
    expect(extractLiveModelCapabilities({
      limits: { max_input_tokens: 262_144 },
      max_output_tokens: 32_768,
      input_modalities: ["text", "image", "audio", "video", "file"],
      primary_output_modality: "text",
      capabilities: {
        supports_stream: true,
        supports_reasoning: false,
        supports_tools: true,
        supports_parallel_tool_calls: true,
        supports_json_output: true,
        supports_citations: true,
      },
    })).toMatchObject({
      limits: { contextWindow: 262_144, maxOutput: 32_768 },
      modalities: {
        input: ["text", "image", "audio", "video", "file"],
        output: ["text"],
      },
      features: { tools: true, reasoning: false, streaming: true },
    });
  });

  it("rejects invalid limits, arbitrary modalities, provenance URLs and executable-looking fields", () => {
    expect(normalizeStoredModelCapabilities({
      limits: { contextWindow: -32_000, maxOutput: "4096 --flag" },
      modalities: { input: ["text", "file", "script", "javascript:alert(1)"] },
      features: { tools: "yes", reasoning: true, command: "calc.exe" },
      provenance: {
        source: "live-provider",
        confidence: "high",
        fields: {
          inputModalities: { source: "curated", confidence: "high", reference: "javascript:alert(1)" },
          reasoning: { source: "live-provider", confidence: "high" },
        },
      },
    })).toEqual({
      modalities: { input: ["text", "file"] },
      features: { reasoning: true },
      provenance: {
        source: "live-provider",
        confidence: "high",
        fields: {
          inputModalities: { source: "curated", confidence: "high" },
          reasoning: { source: "live-provider", confidence: "high" },
        },
      },
    });
  });
});
