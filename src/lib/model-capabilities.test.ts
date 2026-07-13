import { describe, expect, it } from "vitest";

import type { ProviderProtocol } from "@/lib/types";
import { executableModelParams, supportsModelTuning } from "./model-capabilities";

describe("supportsModelTuning", () => {
  it.each<ProviderProtocol>(["openai-chat", "openai-responses"])(
    "enables executable reasoning controls for %s",
    (protocol) => expect(supportsModelTuning(protocol)).toBe(true),
  );

  it.each<ProviderProtocol>([
    "anthropic-messages",
    "google-generative-ai",
    "amazon-bedrock",
    "google-vertex",
  ])("does not advertise unsupported model tuning for %s", (protocol) => {
    expect(supportsModelTuning(protocol)).toBe(false);
  });

  it("defaults unknown provider metadata to unsupported", () => {
    expect(supportsModelTuning(undefined)).toBe(false);
  });
});

describe("executableModelParams", () => {
  it("never sends tuning to protocols that ignore it", () => {
    expect(executableModelParams("anthropic-messages", { effort: "high", fast: true })).toBeUndefined();
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
  });
});
