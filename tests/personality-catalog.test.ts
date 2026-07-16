import { describe, it, expect } from "vitest";
import {
  resolvePersonalityText,
  matchPersonalityPresetId,
  getPersonalityPreset,
} from "../core/engine/personality-catalog.js";
import { resolveEngineConfig } from "../core/engine/config/schema.js";

describe("personality catalog", () => {
  it("resolves preset body when id matches and text is empty or equals body", () => {
    const preset = getPersonalityPreset("concise")!;
    expect(resolvePersonalityText({ personalityPresetId: "concise", personality: "" })).toBe(preset.body);
    expect(resolvePersonalityText({ personalityPresetId: "concise", personality: preset.body })).toBe(preset.body);
  });

  it("prefers free text when it diverges from preset", () => {
    expect(resolvePersonalityText({
      personalityPresetId: "helpful",
      personality: "Speak like a pirate.",
    })).toBe("Speak like a pirate.");
  });

  it("matches catalog bodies back to ids", () => {
    const body = getPersonalityPreset("technical")!.body;
    expect(matchPersonalityPresetId(body)).toBe("technical");
    expect(matchPersonalityPresetId("unique custom tone")).toBe("custom");
    expect(matchPersonalityPresetId("")).toBe("none");
  });

  it("schema defaults personalityPresetId to none", () => {
    expect(resolveEngineConfig({}).config.personalityPresetId).toBe("none");
  });
});
