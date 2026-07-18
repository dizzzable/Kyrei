import { describe, expect, it } from "vitest";
import {
  normalizeProviderAccountMember,
  normalizeProviderAccountPool,
  parseRetryAfterMs,
  ProviderAccountPoolRouter,
} from "../core/provider-account-pool.js";

function pool(
  members: Array<Record<string, unknown>>,
  options: Record<string, unknown> = {},
) {
  return {
    enabled: true,
    strategy: "balanced",
    sessionAffinity: true,
    members,
    ...options,
  };
}

describe("provider account pool normalization", () => {
  it("keeps only renderer-safe metadata, applies defaults, and removes duplicates", () => {
    const member = normalizeProviderAccountMember({
      id: "Primary",
      displayName: "Primary account",
      apiKey: "sk-never-public",
      credentials: { refreshToken: "also-secret" },
      weight: 1_000,
      priority: -4,
    });
    expect(member).toEqual({
      id: "primary",
      name: "Primary account",
      enabled: true,
      weight: 100,
      priority: 0,
      maxConcurrency: 4,
      status: "ready",
      cooldownUntil: 0,
    });

    const config = normalizeProviderAccountPool({
      enabled: true,
      strategy: "unknown",
      members: [
        { ...member, apiKey: "sk-never-public" },
        { id: "primary", name: "duplicate", token: "never-public" },
        { id: "backup", name: "Backup", enabled: false, password: "never-public" },
      ],
      masterKey: "never-public",
    });
    expect(config).toMatchObject({ version: 1, enabled: true, strategy: "balanced", sessionAffinity: true });
    expect(config.members).toHaveLength(2);
    expect(config.members[1]).toMatchObject({ id: "backup", status: "disabled" });
    expect(JSON.stringify(config)).not.toMatch(/sk-never-public|also-secret|never-public|apiKey|password|token|credentials/i);
  });

  it("defaults a pool to disabled so migration cannot silently activate extra accounts", () => {
    expect(normalizeProviderAccountPool({ members: [{ id: "one" }] })).toMatchObject({
      enabled: false,
      strategy: "balanced",
      sessionAffinity: true,
    });
  });

  it("preserves absent versus explicit model rules and bounds renderer-safe IDs", () => {
    const unrestricted = normalizeProviderAccountMember({ id: "all" });
    expect(Object.hasOwn(unrestricted, "modelIds")).toBe(false);

    expect(normalizeProviderAccountMember({
      id: "scoped",
      modelIds: ["alpha", "alpha", "", "x".repeat(513), "beta"],
    })).toMatchObject({ modelIds: ["alpha", "beta"] });
    expect(normalizeProviderAccountMember({ id: "denied", modelIds: [] })).toMatchObject({ modelIds: [] });
    expect(normalizeProviderAccountMember({ id: "invalid", modelIds: "alpha" })).toMatchObject({ modelIds: [] });
    expect(normalizeProviderAccountMember({
      id: "bounded",
      modelIds: Array.from({ length: 2_001 }, (_, index) => `model-${index}`),
    }).modelIds).toHaveLength(2_000);
  });
});

describe("ProviderAccountPoolRouter", () => {
  it("resets only ephemeral runtime state without enabling a disabled account", () => {
    const router = new ProviderAccountPoolRouter({
      config: pool([
        { id: "primary", name: "Primary", enabled: true },
        { id: "disabled", name: "Disabled", enabled: false, status: "disabled" },
      ]),
    });
    router.reportFailure("primary", { statusCode: 401, failureClass: "auth_uncertain" });
    router.reportFailure("primary", { statusCode: 401, failureClass: "auth_uncertain" });
    expect(router.getMember("primary")?.status).toBe("auth-required");

    expect(router.resetRuntime("primary")).toMatchObject({ status: "ready", failures: 0 });
    expect(router.resetRuntime("disabled")).toMatchObject({ status: "disabled", enabled: false });
    expect(router.resetRuntime("missing")).toBeNull();
  });
  it("balances by weighted inflight load, last use, and then keeps soft session affinity", () => {
    let now = 100;
    const router = new ProviderAccountPoolRouter({
      config: pool([
        { id: "small", weight: 1 },
        { id: "large", weight: 2 },
      ]),
      now: () => now,
    });

    const first = router.acquire({ sessionId: "session-a" })!;
    expect(first.accountId).toBe("large");
    router.release(first);

    now += 1;
    expect(router.acquire({ sessionId: "session-a" })?.accountId).toBe("large");
    expect(router.orderedCandidates({ sessionId: "new-session" }).map((entry) => entry.id)).toEqual(["small", "large"]);
  });

  it("advances round-robin only on acquire and returns deterministic candidate order", () => {
    const router = new ProviderAccountPoolRouter({
      config: pool([
        { id: "one" },
        { id: "two" },
        { id: "three" },
      ], { strategy: "round-robin", sessionAffinity: false }),
    });

    expect(router.orderedCandidates().map((entry) => entry.id)).toEqual(["one", "two", "three"]);
    expect(router.orderedCandidates().map((entry) => entry.id)).toEqual(["one", "two", "three"]);
    const one = router.acquire()!;
    expect(one.accountId).toBe("one");
    expect(router.orderedCandidates().map((entry) => entry.id)).toEqual(["two", "three", "one"]);
    router.release(one);
    expect(router.acquire()?.accountId).toBe("two");
  });

  it("uses fill-first priority until an account becomes unavailable", () => {
    let now = 1_000;
    const router = new ProviderAccountPoolRouter({
      config: pool([
        { id: "secondary", priority: 10 },
        { id: "primary", priority: 0 },
      ], { strategy: "fill-first", sessionAffinity: false }),
      now: () => now,
    });

    expect(router.acquire()?.accountId).toBe("primary");
    expect(router.acquire()?.accountId).toBe("primary");
    expect(router.reportFailure("primary", { statusCode: 429 })?.status).toBe("cooldown");
    expect(router.orderedCandidates().map((entry) => entry.id)).toEqual(["secondary"]);
    now += 1_000;
    expect(router.orderedCandidates().map((entry) => entry.id)).toEqual(["primary", "secondary"]);
  });

  it("tracks idempotent acquisition release without exposing internal state", () => {
    const router = new ProviderAccountPoolRouter({ config: pool([{ id: "one", apiKey: "secret" }]) });
    const lease = router.acquire()!;
    expect(lease.member.inflight).toBe(1);
    expect(router.getMember("one")?.inflight).toBe(1);
    expect(router.release(lease)).toBe(true);
    expect(router.release(lease)).toBe(false);
    expect(router.getMember("one")?.inflight).toBe(0);
    expect(JSON.stringify({ lease, config: router.getConfig(), members: router.listMembers() })).not.toContain("secret");
  });

  it("fails closed at per-account capacity and honours a ready durable preference", () => {
    const router = new ProviderAccountPoolRouter({
      config: pool([
        { id: "one", maxConcurrency: 1 },
        { id: "two", maxConcurrency: 1 },
      ]),
    });
    const preferred = router.acquire({ sessionId: "session", preferredAccountId: "two" })!;
    expect(preferred.accountId).toBe("two");
    const remaining = router.acquire()!;
    expect(remaining.accountId).toBe("one");
    expect(router.orderedCandidates()).toEqual([]);
    expect(router.acquire()).toBeNull();
    router.release(preferred);
    expect(router.orderedCandidates().map((entry) => entry.id)).toEqual(["two"]);
  });

  it("applies Retry-After and exponential cooldowns within the configured bound", () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const router = new ProviderAccountPoolRouter({
      config: pool([{ id: "one" }]),
      now: () => now,
      baseCooldownMs: 1_000,
      maxCooldownMs: 5_000,
    });

    const first = router.reportFailure("one", { statusCode: 429, retryAfter: "3" })!;
    expect(first).toMatchObject({ status: "cooldown", cooldownUntil: now + 3_000, failures: 1 });
    expect(router.orderedCandidates()).toEqual([]);

    now += 3_000;
    expect(router.getMember("one")?.status).toBe("ready");
    const second = router.reportFailure("one", {
      retryable: true,
      retryAfter: new Date(now + 60_000).toUTCString(),
    })!;
    expect(second.cooldownUntil).toBe(now + 5_000);
    now += 5_000;
    expect(router.reportSuccess("one")).toMatchObject({ status: "ready", failures: 0, cooldownUntil: 0 });
  });

  it("honours long provider Retry-After windows up to the shared 24 hour safety bound", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const router = new ProviderAccountPoolRouter({
      config: pool([{ id: "one" }]),
      now: () => now,
    });

    expect(router.reportFailure("one", {
      statusCode: 429,
      retryAfterMs: 6 * 60 * 60_000,
    })).toMatchObject({
      status: "cooldown",
      cooldownUntil: now + 6 * 60 * 60_000,
    });
    expect(router.reportFailure("one", {
      statusCode: 429,
      retryAfterMs: 48 * 60 * 60_000,
    })?.cooldownUntil).toBe(now + 24 * 60 * 60_000);
  });

  it("marks explicit invalid-key failures and disabled members as unavailable", () => {
    const router = new ProviderAccountPoolRouter({
      config: pool([
        { id: "primary" },
        { id: "disabled", enabled: false },
      ]),
    });

    expect(router.reportFailure("primary", {
      statusCode: 401,
      message: "Invalid API key provided",
    })?.status).toBe("auth-required");
    expect(router.listMembers().map((entry) => [entry.id, entry.status])).toEqual([
      ["primary", "auth-required"],
      ["disabled", "disabled"],
    ]);
    expect(router.orderedCandidates()).toEqual([]);
    expect(router.reportSuccess("primary")?.status).toBe("ready");
  });

  it("never parks a seat as auth-required on pure network / transport noise", () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const router = new ProviderAccountPoolRouter({
      config: pool([{ id: "primary" }, { id: "spare" }]),
      now: () => now,
      networkCooldownMs: 1_000,
    });

    const first = router.reportFailure("primary", {
      failureClass: "network",
      retryable: true,
    })!;
    expect(first).toMatchObject({
      status: "cooldown",
      lastFailureClass: "network",
      softAuthStrikes: 0,
    });
    expect(first.cooldownUntil).toBe(now + 1_000);
    expect(router.orderedCandidates().map((entry) => entry.id)).toEqual(["spare"]);

    now += 1_000;
    expect(router.getMember("primary")?.status).toBe("ready");
    expect(router.reportSuccess("primary")?.status).toBe("ready");
  });

  it("treats soft 403 as cooldown-only and never escalates it into auth-required", () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const router = new ProviderAccountPoolRouter({
      config: pool([{ id: "primary" }]),
      now: () => now,
      baseCooldownMs: 1_000,
    });

    const first = router.reportFailure("primary", { statusCode: 403 })!;
    expect(first).toMatchObject({
      status: "cooldown",
      softAuthStrikes: 1,
      lastFailureClass: "auth_soft",
    });
    now = first.cooldownUntil;
    expect(router.getMember("primary")?.status).toBe("ready");

    const second = router.reportFailure("primary", { failureClass: "auth_soft", statusCode: 403 })!;
    expect(second).toMatchObject({ status: "cooldown", softAuthStrikes: 2 });
    now = second.cooldownUntil;

    // Intervening network blip resets soft-auth accumulation (anti-false-ban).
    router.reportFailure("primary", { failureClass: "network", retryable: true });
    expect(router.getMember("primary")).toMatchObject({
      status: "cooldown",
      softAuthStrikes: 0,
      lastFailureClass: "network",
    });
    now = router.getMember("primary")!.cooldownUntil;

    router.reportFailure("primary", { statusCode: 403 });
    now = router.getMember("primary")!.cooldownUntil;
    router.reportFailure("primary", { statusCode: 403 });
    now = router.getMember("primary")!.cooldownUntil;
    const third = router.reportFailure("primary", { statusCode: 403 })!;
    expect(third).toMatchObject({
      status: "cooldown",
      softAuthStrikes: 3,
    });
    expect(Object.hasOwn(third, "authRequired")).toBe(false);
    now = router.getMember("primary")!.cooldownUntil - 1;
    expect(router.getMember("primary")?.status).toBe("cooldown");
    now += 1;
    expect(router.getMember("primary")?.status).toBe("ready");
  });

  it("requires two consecutive ambiguous 401 strikes before parking a custom account", () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const router = new ProviderAccountPoolRouter({
      config: pool([{ id: "primary" }]),
      now: () => now,
      baseCooldownMs: 1_000,
    });

    const first = router.reportFailure("primary", {
      statusCode: 401,
      protocol: "openai-chat",
      providerId: "xpiki",
      message: "Unauthorized",
    })!;
    expect(first).toMatchObject({
      status: "cooldown",
      lastFailureClass: "auth_uncertain",
    });
    now = first.cooldownUntil;
    expect(router.getMember("primary")?.status).toBe("ready");

    const second = router.reportFailure("primary", {
      statusCode: 401,
      protocol: "openai-chat",
      providerId: "xpiki",
      message: "Unauthorized",
    })!;
    expect(second.status).toBe("auth-required");
  });

  it("clears ambiguous-auth accumulation after a non-auth transient failure", () => {
    let now = Date.parse("2026-01-01T00:00:00Z");
    const router = new ProviderAccountPoolRouter({
      config: pool([{ id: "primary" }]),
      now: () => now,
      baseCooldownMs: 1_000,
      networkCooldownMs: 500,
    });

    const first = router.reportFailure("primary", { statusCode: 401, message: "Unauthorized" })!;
    expect(first.lastFailureClass).toBe("auth_uncertain");
    now = first.cooldownUntil;

    router.reportFailure("primary", { failureClass: "network", retryable: true });
    expect(router.getMember("primary")).toMatchObject({
      lastFailureClass: "network",
      definiteAuthStrikes: 0,
    });
    now = router.getMember("primary")!.cooldownUntil;

    const second = router.reportFailure("primary", { statusCode: 401, message: "Unauthorized" })!;
    expect(second.status).toBe("cooldown");
  });

  it("moves a soft session lease after its member cools down and supports explicit exclusions", () => {
    const router = new ProviderAccountPoolRouter({
      config: pool([{ id: "one" }, { id: "two" }]),
    });
    const first = router.acquire({ sessionId: "session" })!;
    router.release(first);
    expect(router.getSessionAccount("session")).toBe(first.accountId);
    router.reportFailure(first.accountId, { statusCode: 503 });
    expect(router.getSessionAccount("session")).toBeNull();
    const second = router.acquire({ sessionId: "session" })!;
    expect(second.accountId).not.toBe(first.accountId);
    expect(router.orderedCandidates({ excludeAccountIds: [second.accountId] })).toEqual([]);
  });

  it("does not route when the pool is disabled", () => {
    const router = new ProviderAccountPoolRouter({
      config: { members: [{ id: "one" }] },
    });
    expect(router.orderedCandidates()).toEqual([]);
    expect(router.acquire()).toBeNull();
  });

  it("filters model eligibility before preferred and session affinity routing", () => {
    const router = new ProviderAccountPoolRouter({
      config: pool([
        { id: "alpha-only", modelIds: ["alpha"] },
        { id: "unrestricted" },
        { id: "denied", modelIds: [] },
      ]),
    });

    const alpha = router.acquire({
      sessionId: "session",
      preferredAccountId: "alpha-only",
      modelId: "alpha",
    })!;
    expect(alpha.accountId).toBe("alpha-only");
    router.release(alpha);

    expect(router.orderedCandidates({ sessionId: "session", modelId: "beta" }).map((entry) => entry.id))
      .toEqual(["unrestricted"]);
    expect(router.acquire({ accountId: "alpha-only", modelId: "beta" })).toBeNull();
    expect(router.orderedCandidates().map((entry) => entry.id)).toEqual(["unrestricted"]);
    expect(router.getMember("denied")).toMatchObject({ modelIds: [] });
  });
});

describe("parseRetryAfterMs", () => {
  it("supports delta seconds and HTTP dates", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfterMs("1.5", now)).toBe(1_500);
    expect(parseRetryAfterMs(new Date(now + 4_000).toUTCString(), now)).toBe(4_000);
    expect(parseRetryAfterMs("invalid", now)).toBe(0);
  });
});
