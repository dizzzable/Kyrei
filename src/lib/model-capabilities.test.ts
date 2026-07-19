import { describe, expect, it } from "vitest";

import type { ProviderProtocol } from "@/lib/types";
import { allowsConfiguredEndpointTuning, executableModelParams, supportsModelTuning } from "./model-capabilities";

describe("supportsModelTuning", () => {
  it("permits an operator-selected compatible endpoint but keeps OpenAI's catalog authoritative", () => {
    expect(allowsConfiguredEndpointTuning({ protocol: "openai-chat", baseURL: "https://proxy.example.test/v1" })).toBe(true);
    expect(allowsConfiguredEndpointTuning({ protocol: "openai-chat", baseURL: "https://api.openai.com/v1" })).toBe(false);
    expect(allowsConfiguredEndpointTuning({ protocol: "anthropic-messages", baseURL: "https://proxy.example.test" })).toBe(false);
  });

  it.each<ProviderProtocol>([
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "amazon-bedrock",
    "google-vertex",
    "codex-app-server",
  ])(
    "enables executable reasoning controls for %s",
    (protocol) => expect(supportsModelTuning(protocol)).toBe(true),
  );

  it("honors explicit live metadata that disables reasoning for a model", () => {
    const explicitlyDisabled = {
      provenance: { source: "live-provider", confidence: "high", fields: {} },
      features: { reasoning: false },
    } as const;
    expect(supportsModelTuning("anthropic-messages", explicitlyDisabled)).toBe(false);
    // A user-managed compatible endpoint has an explicitly selected request
    // dialect; stale discovery metadata must not hide its controls.
    expect(supportsModelTuning("openai-chat", explicitlyDisabled, {
      allowConfiguredEndpointTuning: true,
    })).toBe(true);
  });

  it("defaults unknown provider metadata to unsupported", () => {
    expect(supportsModelTuning(undefined)).toBe(false);
  });
});

describe("executableModelParams", () => {
  it("sends tuning to supported non-OpenAI protocols too", () => {
    expect(executableModelParams("anthropic-messages", { effort: "high", fast: true })).toEqual({ fast: true });
  });

  it("keeps Fast executable by omitting a stale explicit effort", () => {
    expect(executableModelParams("openai-chat", { thinking: true, effort: "medium", fast: true })).toEqual({
      fast: true,
    });
  });

  it("keeps explicit off authoritative over a stale Fast value", () => {
    expect(executableModelParams("openai-responses", { thinking: false, fast: true })).toEqual({ effort: "off" });
  });

  it("preserves supported explicit and default reasoning choices", () => {
    expect(executableModelParams("openai-chat", {})).toBeUndefined();
    expect(executableModelParams("openai-chat", { effort: "high" })).toEqual({ effort: "high" });
    expect(executableModelParams("openai-chat", { thinking: true })).toEqual({ effort: "medium" });
    expect(executableModelParams("google-generative-ai", { thinking: true })).toEqual({ effort: "medium" });
    expect(executableModelParams("codex-app-server", { thinking: true })).toEqual({ effort: "medium" });
  });

  it("forwards bounded manual limits independently of protocol tuning support", () => {
    expect(executableModelParams("anthropic-messages", {
      effort: "high",
      contextWindowOverride: 200_000,
      maxOutputOverride: 64_000,
    })).toEqual({ effort: "high", contextWindowOverride: 200_000, maxOutputOverride: 64_000 });
    expect(executableModelParams("openai-responses", {
      effort: "high",
      contextWindowOverride: 1_050_000,
      maxOutputOverride: 128_000,
    })).toEqual({ effort: "high", contextWindowOverride: 1_050_000, maxOutputOverride: 128_000 });
  });

  it("drops malformed or out-of-range manual limits before the gateway request", () => {
    expect(executableModelParams("google-generative-ai", {
      contextWindowOverride: 255,
      maxOutputOverride: 1.5,
    })).toBeUndefined();
    expect(executableModelParams("openai-chat", {
      effort: "low",
      contextWindowOverride: Number.NaN,
      maxOutputOverride: 10_000_001,
    })).toEqual({ effort: "low" });
  });
});
