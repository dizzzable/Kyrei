import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { $modelPresets } from "@/store/model-presets";
import { ModelCapabilitySettings, type ModelCapabilitySettingsCopy } from "./ModelCapabilitySettings";

const copy: ModelCapabilitySettingsCopy = {
  title: "Model capabilities",
  description: "Detected values remain visible; overrides are explicit.",
  contextWindow: "Context window",
  maxOutput: "Max output",
  detected: "Detected",
  overridePlaceholder: "Override",
  overrideActive: "Custom override",
  reset: "Reset",
  invalidValue: "Enter a valid whole-token value.",
  unknown: "Unknown",
  inputModalities: "Input",
  outputModalities: "Output",
  features: "Features",
  featureTools: "Tools",
  featureReasoning: "Reasoning",
  featureStreaming: "Streaming",
  supported: "Supported",
  unsupported: "Unsupported",
  source: {
    "live-provider": "Live provider",
    curated: "Curated",
    mixed: "Live + curated",
    "user-override": "User override",
    unknown: "Unknown source",
  },
  confidence: { high: "High", medium: "Medium", low: "Low", unknown: "Unknown confidence" },
  modality: { text: "Text", image: "Image", audio: "Audio", video: "Video", file: "Files" },
};

describe("ModelCapabilitySettings", () => {
  beforeEach(() => $modelPresets.set({}));

  it("shows detected limits, modalities, support and truthful provenance", () => {
    const html = renderToStaticMarkup(createElement(ModelCapabilitySettings, {
      providerId: "openai",
      modelId: "gpt-4o-mini",
      locale: "en",
      copy,
      metadata: {
        limits: { contextWindow: 128_000, maxOutput: 16_384 },
        modalities: { input: ["text", "image"], output: ["text"] },
        features: { tools: true, reasoning: false, streaming: true },
        provenance: { source: "curated", confidence: "high", fields: {} },
      },
    }));

    expect(html).toContain("Model capabilities");
    expect(html).toContain("128k");
    expect(html).toContain("16,384");
    expect(html).toContain("Text");
    expect(html).toContain("Image");
    expect(html).toContain("Tools: Supported");
    expect(html).toContain("Reasoning: Unsupported");
    expect(html).toContain("Curated · High");
  });

  it("renders unknown instead of a fabricated context limit", () => {
    const html = renderToStaticMarkup(createElement(ModelCapabilitySettings, {
      providerId: "custom",
      modelId: "unknown",
      locale: "en",
      copy,
    }));
    expect(html).toContain("Detected: —");
    expect(html).toContain("Unknown source · Unknown confidence");
    expect(html).not.toContain("32k");
  });
});
