import { beforeEach, describe, expect, it } from "vitest";

import {
  $modelPresets,
  getModelPreset,
  normalizeModelLimitOverride,
  setModelPreset,
} from "./model-presets";

describe("model limit overrides", () => {
  beforeEach(() => $modelPresets.set({}));

  it("stores context and output overrides per provider/model", () => {
    setModelPreset("provider-a", "shared", { contextWindowOverride: 96_000, maxOutputOverride: 8_192 });
    expect(getModelPreset("provider-a", "shared")).toMatchObject({
      contextWindowOverride: 96_000,
      maxOutputOverride: 8_192,
    });
    expect(getModelPreset("provider-b", "shared")).toEqual({});
  });

  it("accepts only bounded whole-token limits", () => {
    expect(normalizeModelLimitOverride("128000", "contextWindow")).toBe(128_000);
    expect(normalizeModelLimitOverride("", "contextWindow")).toBeUndefined();
    expect(normalizeModelLimitOverride("32k", "contextWindow")).toBeUndefined();
    expect(normalizeModelLimitOverride(255, "contextWindow")).toBeUndefined();
    expect(normalizeModelLimitOverride(1.5, "maxOutput")).toBeUndefined();
    expect(normalizeModelLimitOverride(10_000_001, "maxOutput")).toBeUndefined();
  });
});
