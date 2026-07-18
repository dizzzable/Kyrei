import { describe, expect, it } from "vitest";
import {
  dedupeRuntimeTargets,
  familyIdForModel,
  listFamilyModelRefs,
  modelsShareFamily,
  normalizeCapacityConfig,
  orderCapacityCandidates,
} from "../core/capacity-router.js";

describe("capacity-router", () => {
  it("classifies model families", () => {
    expect(familyIdForModel("claude-sonnet-4")).toBe("claude");
    expect(familyIdForModel("gpt-4o-mini")).toBe("gpt");
    expect(familyIdForModel("grok-3")).toBe("grok");
    expect(modelsShareFamily("claude-opus", "anthropic/claude-sonnet")).toBe(true);
    expect(modelsShareFamily("gpt-4o", "grok-3")).toBe(false);
  });

  it("orders spare accounts first then family then fallbacks", () => {
    const ordered = orderCapacityCandidates({
      primaryTargets: [
        { providerId: "anthropic", accountId: "a1", model: "claude-sonnet" },
        { providerId: "anthropic", accountId: "a2", model: "claude-sonnet" },
      ],
      familyTargets: [
        { providerId: "openrouter", accountId: "primary", model: "anthropic/claude-sonnet" },
      ],
      fallbackTargets: [
        { providerId: "openai", accountId: "primary", model: "gpt-4o-mini" },
      ],
      capacity: { enabled: true, strategy: "spare-first", crossProviderFamily: true },
    });
    expect(ordered.map((t) => `${t.providerId}:${t.accountId}`)).toEqual([
      "anthropic:a1",
      "anthropic:a2",
      "openrouter:primary",
      "openai:primary",
    ]);
  });

  it("dedupes identical targets", () => {
    expect(dedupeRuntimeTargets([
      { providerId: "p", accountId: "a", model: "m" },
      { providerId: "p", accountId: "a", model: "m" },
    ])).toHaveLength(1);
  });

  it("lists family siblings across providers", () => {
    const refs = listFamilyModelRefs({
      providers: [
        { id: "anthropic", enabled: true, models: [{ id: "claude-sonnet" }] },
        { id: "openrouter", enabled: true, models: [{ id: "anthropic/claude-sonnet" }, { id: "gpt-4o" }] },
        { id: "xai", enabled: true, models: [{ id: "grok-3" }] },
      ],
    }, "anthropic", "claude-sonnet");
    expect(refs).toEqual([{ providerId: "openrouter", modelId: "anthropic/claude-sonnet" }]);
  });

  it("normalizes capacity defaults", () => {
    expect(normalizeCapacityConfig({})).toEqual({
      enabled: true,
      strategy: "spare-first",
      preferSpare: true,
      crossProviderFamily: true,
      subscriptionShield: {
        enabled: true,
        mode: "stealth",
        minIntervalMs: 75,
        connectTimeoutMs: 0,
        headerTimeoutMs: 0,
        inactivityTimeoutMs: 0,
        maxConnectionsPerOrigin: 4,
      },
    });
  });

  it("keeps explicit current transport timeout fields and ignores the legacy hard cutoff", () => {
    expect(normalizeCapacityConfig({
      subscriptionShield: {
        connectTimeoutMs: 0,
        inactivityTimeoutMs: 0,
      },
    }).subscriptionShield).toMatchObject({
      headerTimeoutMs: 0,
      inactivityTimeoutMs: 0,
    });

    expect(normalizeCapacityConfig({
      subscriptionShield: {
        connectTimeoutMs: 15_000,
        headerTimeoutMs: 12_000,
        inactivityTimeoutMs: 18_000,
      },
    }).subscriptionShield).toMatchObject({
      headerTimeoutMs: 12_000,
      inactivityTimeoutMs: 18_000,
    });
    expect(normalizeCapacityConfig({
      subscriptionShield: { connectTimeoutMs: 30_000 },
    }).subscriptionShield).toMatchObject({
      headerTimeoutMs: 0,
      connectTimeoutMs: 0,
    });
  });
});
