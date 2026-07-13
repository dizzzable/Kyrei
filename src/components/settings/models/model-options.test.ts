import { describe, expect, it } from "vitest";

import type { ModelRef, ProviderProfile } from "@/lib/types";
import {
  isSameModelRef,
  isProviderReady,
  modelOptionsForProvider,
  selectableModelProviders,
  resolveModelAssignment,
} from "./model-options";

const providers: ProviderProfile[] = [
  {
    id: "first",
    name: "First",
    protocol: "openai-chat",
    baseURL: "https://first.example/v1",
    models: [{ id: "shared", name: "Shared first" }],
    enabled: true,
    requiresApiKey: true,
    hasKey: true,
  },
  {
    id: "second",
    name: "Second",
    protocol: "openai-chat",
    baseURL: "https://second.example/v1",
    models: [{ id: "shared", name: "Shared second" }, { id: "worker" }],
    enabled: true,
    requiresApiKey: true,
    hasKey: true,
  },
];

describe("model settings options", () => {
  it("keeps duplicate model ids provider-scoped", () => {
    expect(modelOptionsForProvider(providers, "first")).toEqual([{ id: "shared", name: "Shared first" }]);
    expect(modelOptionsForProvider(providers, "second")).toEqual([
      { id: "shared", name: "Shared second" },
      { id: "worker" },
    ]);
    expect(isSameModelRef({ providerId: "first", modelId: "shared" }, { providerId: "second", modelId: "shared" })).toBe(false);
  });

  it("represents worker inheritance explicitly", () => {
    const main: ModelRef = { providerId: "first", modelId: "shared" };

    expect(resolveModelAssignment(undefined, main)).toEqual({ ref: main, inherited: true });
    expect(resolveModelAssignment({ providerId: "second", modelId: "worker" }, main)).toEqual({
      ref: { providerId: "second", modelId: "worker" },
      inherited: false,
    });
  });

  it("excludes providers that cannot execute while preserving an explicitly shown current provider", () => {
    const unavailable: ProviderProfile = {
      ...providers[0],
      id: "needs-key",
      name: "Needs key",
      hasKey: false,
    };
    const disabled: ProviderProfile = { ...providers[1], id: "disabled", enabled: false };

    expect(isProviderReady(unavailable)).toBe(false);
    expect(isProviderReady(providers[0])).toBe(true);
    expect(selectableModelProviders([...providers, unavailable, disabled]).map((provider) => provider.id)).toEqual([
      "first",
      "second",
    ]);
    expect(selectableModelProviders([...providers, unavailable, disabled], "needs-key").map((provider) => provider.id)).toEqual([
      "first",
      "second",
      "needs-key",
    ]);
  });
});
