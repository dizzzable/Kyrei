import { describe, expect, it } from "vitest";
import {
  dedupeRuntimeTargets,
  familyIdForModel,
  listFamilyModelRefs,
  modelsShareFamily,
  normalizeCapacityConfig,
  orderCapacityCandidates,
  poolStrategyForCapacity,
} from "../core/capacity-router.js";
import { normalizeProviderAccountPool as gatewayNormalizeAccountPool } from "../core/provider-config.js";

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
    });
  });

  it("drops a persisted legacy subscriptionShield block instead of carrying it forward", () => {
    // The transport layer it configured was removed in v0.7.7; provider SDKs own
    // their streaming lifecycle. Normalizing the key away keeps a stale timeout
    // from being rewritten into the saved config on every load.
    const normalized = normalizeCapacityConfig({
      enabled: true,
      subscriptionShield: {
        enabled: true,
        mode: "stealth",
        connectTimeoutMs: 15_000,
        inactivityTimeoutMs: 18_000,
      },
    });
    expect(normalized).not.toHaveProperty("subscriptionShield");
    expect(JSON.stringify(normalized)).not.toContain("Timeout");
  });
});

describe("poolStrategyForCapacity", () => {
  // The workspace-wide Capacity strategy is inert on its own: the runtime
  // targets orderCapacityCandidates sees carry no per-account state. It reaches
  // the provider account pool — which does hold that state — as the default for
  // a pool the user never configured individually.
  it("maps reserve-keeping strategies onto fill-first", () => {
    // Shipped copy: spare-first is "burn the active account; keep a reserve",
    // and priority is documented as "same as fill-first for pools".
    expect(poolStrategyForCapacity({ strategy: "spare-first" })).toBe("fill-first");
    expect(poolStrategyForCapacity({ strategy: "fill-first" })).toBe("fill-first");
    expect(poolStrategyForCapacity({ strategy: "priority" })).toBe("fill-first");
  });

  it("passes through the strategies the pool implements by the same name", () => {
    expect(poolStrategyForCapacity({ strategy: "round-robin" })).toBe("round-robin");
    expect(poolStrategyForCapacity({ strategy: "least-used" })).toBe("least-used");
    expect(poolStrategyForCapacity({ strategy: "balanced" })).toBe("balanced");
  });

  it("spreads load when the user does not want a cold reserve", () => {
    // preferSpare is documented as "keep at least one key cold"; off means the
    // opposite, and it wins over a reserve-keeping strategy.
    expect(poolStrategyForCapacity({ strategy: "spare-first", preferSpare: false })).toBe("balanced");
    expect(poolStrategyForCapacity({ strategy: "spare-first", preferSpare: true })).toBe("fill-first");
  });

  it("falls back to balanced for junk and missing input", () => {
    expect(poolStrategyForCapacity(undefined)).toBe("balanced");
    expect(poolStrategyForCapacity({})).toBe("balanced");
    expect(poolStrategyForCapacity({ strategy: "nonsense" })).toBe("balanced");
  });

  it("maps the NORMALIZED default the gateway would actually pass", () => {
    // The two assertions above describe a raw object the gateway never hands
    // over: it always normalizes first, and the normalized default is
    // `spare-first` → `fill-first`. Pinning only the raw shape hid that
    // feeding the normalized default downstream would flip every untouched
    // pool from `balanced` on upgrade.
    expect(poolStrategyForCapacity(normalizeCapacityConfig({}))).toBe("fill-first");
  });
});

describe("account pool strategy default", () => {
  // Exercised through `provider-config.js` — the module the GATEWAY imports.
  // The identically named function in `provider-account-pool.js` is NOT on that
  // path, and testing it directly is how a completely inert change passed green.
  it("applies the capacity default only when the pool has no strategy of its own", () => {
    const pool = (source: Record<string, unknown>, options?: { defaultStrategy?: string }) =>
      gatewayNormalizeAccountPool(source, [{ id: "m1" }], options).strategy;

    expect(pool({ enabled: true }, { defaultStrategy: "round-robin" })).toBe("round-robin");
    // An explicit per-provider choice always wins.
    expect(pool({ enabled: true, strategy: "least-used" }, { defaultStrategy: "round-robin" })).toBe("least-used");
    // Junk is not an explicit choice.
    expect(pool({ enabled: true, strategy: "bogus" }, { defaultStrategy: "round-robin" })).toBe("round-robin");
    // Unchanged without a default.
    expect(pool({ enabled: true })).toBe("balanced");
  });

  it("keeps filtering stale per-account model pins", () => {
    // The options object was once passed in `providerModels`' place, which
    // silently disabled this filter — an account pinned to a deleted model
    // stayed routable.
    const withStalePin = gatewayNormalizeAccountPool(
      { enabled: true, members: [{ id: "primary" }, { id: "b", modelIds: ["gone"] }] },
      [{ id: "m1" }],
      { defaultStrategy: "round-robin" },
    );
    const member = withStalePin.members.find((m: { id: string }) => m.id === "b");
    expect(member?.modelIds ?? []).toEqual([]);
  });
});
