import { describe, expect, it } from "vitest";

import type { ModelCapabilityMetadata } from "@/lib/types";
import { compactTokenCount, effectiveModelLimits, orderedModalities } from "./model-metadata";

const detected: ModelCapabilityMetadata = {
  limits: { contextWindow: 128_000, maxOutput: 16_384 },
  modalities: { input: ["image", "text"], output: ["text"] },
  features: { tools: true, reasoning: false, streaming: true },
  provenance: { source: "curated", confidence: "high", fields: {} },
};

describe("renderer model metadata", () => {
  it("keeps detected limits unless an explicit user override exists", () => {
    expect(effectiveModelLimits(detected, {})).toEqual({
      contextWindow: 128_000,
      maxOutput: 16_384,
      contextSource: "detected",
      outputSource: "detected",
    });
    expect(effectiveModelLimits(detected, { contextWindowOverride: 96_000 })).toEqual({
      contextWindow: 96_000,
      maxOutput: 16_384,
      contextSource: "override",
      outputSource: "detected",
    });
  });

  it("represents unknown data as unknown instead of a guessed number", () => {
    expect(effectiveModelLimits(undefined, {})).toEqual({
      contextSource: "unknown",
      outputSource: "unknown",
    });
  });

  it("orders known modalities and formats token counts compactly", () => {
    expect(orderedModalities(["video", "text", "image"])).toEqual(["text", "image", "video"]);
    expect(compactTokenCount(1_048_576, "en")).toBe("1,048,576");
    expect(compactTokenCount(128_000, "en")).toBe("128k");
    expect(compactTokenCount(undefined, "ru")).toBe("—");
  });
});
