import { describe, expect, it } from "vitest";
import type { ProviderProfile } from "@/lib/types";
import { moveFallbackModel, nextFallbackModel, normalizeFallbackModels } from "./fallback-chain";

const providers: ProviderProfile[] = [
  {
    id: "primary",
    name: "Primary",
    protocol: "openai-chat",
    baseURL: "https://primary.example/v1",
    enabled: true,
    requiresApiKey: true,
    hasKey: true,
    models: [{ id: "main" }, { id: "backup/local" }],
  },
  {
    id: "other",
    name: "Other",
    protocol: "anthropic-messages",
    baseURL: "https://other.example/v1",
    enabled: true,
    requiresApiKey: true,
    hasKey: true,
    models: [{ id: "vendor/model/with/slashes" }],
  },
];

describe("fallback model helpers", () => {
  it("keeps provider-qualified order, slash model ids, and removes duplicates", () => {
    expect(normalizeFallbackModels([
      { providerId: "other", modelId: "vendor/model/with/slashes" },
      { providerId: "primary", modelId: "backup/local" },
      { providerId: "other", modelId: "vendor/model/with/slashes" },
      { providerId: "missing", modelId: "ignored" },
    ], providers)).toEqual([
      { providerId: "other", modelId: "vendor/model/with/slashes" },
      { providerId: "primary", modelId: "backup/local" },
    ]);
  });

  it("adds the first unused ready target and reorders without mutating input", () => {
    const current = [{ providerId: "other", modelId: "vendor/model/with/slashes" }];
    expect(nextFallbackModel(current, providers, { providerId: "primary", modelId: "main" }))
      .toEqual({ providerId: "primary", modelId: "backup/local" });
    const moved = moveFallbackModel([
      { providerId: "primary", modelId: "backup/local" },
      { providerId: "other", modelId: "vendor/model/with/slashes" },
    ], 1, 0);
    expect(moved.map((value) => value.providerId)).toEqual(["other", "primary"]);
  });
});
