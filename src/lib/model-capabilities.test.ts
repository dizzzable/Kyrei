import { describe, expect, it } from "vitest";

import type { ProviderProtocol } from "@/lib/types";
import { executableModelParams, supportsModelTuning } from "./model-capabilities";

describe("supportsModelTuning", () => {
  it.each<ProviderProtocol>([
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "amazon-bedrock",
    "google-vertex",
  ])(
    "enables executable reasoning controls for %s",
    (protocol) => expect(supportsModelTuning(protocol)).toBe(true),
  );

  it("honors explicit live metadata that disables reasoning for a model", () => {
    expect(supportsModelTuning("anthropic-messages", {
      provenance: { source: "live-provider", confidence: "high", fields: {} },
      features: { reasoning: false },
    })).toBe(false);
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
