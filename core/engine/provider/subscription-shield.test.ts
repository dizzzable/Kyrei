import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySubscriptionShieldHeaders,
  closeSubscriptionShieldDispatcher,
  createSubscriptionShieldTimeoutError,
  normalizeSubscriptionShield,
  paceSubscriptionRequest,
  resetSubscriptionShieldPaceForTests,
  shouldHideEngineIdentity,
  subscriptionShieldDefaultHeaders,
  wrapFetchWithSubscriptionShield,
} from "./subscription-shield.js";

afterEach(async () => {
  resetSubscriptionShieldPaceForTests();
  await closeSubscriptionShieldDispatcher();
  vi.useRealTimers();
});

describe("normalizeSubscriptionShield", () => {
  it("defaults to stealth enabled for OOB seat protection", () => {
    expect(normalizeSubscriptionShield(undefined)).toMatchObject({
      enabled: true,
      mode: "stealth",
      minIntervalMs: 75,
      maxConnectionsPerOrigin: 4,
    });
  });

  it("honours explicit off", () => {
    expect(normalizeSubscriptionShield({ mode: "off" })).toMatchObject({
      enabled: false,
      mode: "off",
    });
    expect(normalizeSubscriptionShield({ enabled: false, mode: "stealth" })).toMatchObject({
      enabled: false,
      mode: "off",
    });
  });
});

describe("subscription shield headers", () => {
  it("stealth fills browser defaults and strips Kyrei identity", () => {
    const headers = new Headers({ "X-Kyrei-Engine": "v2", Authorization: "Bearer secret" });
    applySubscriptionShieldHeaders(headers, "stealth");
    expect(headers.get("Authorization")).toBe("Bearer secret");
    expect(headers.get("X-Kyrei-Engine")).toBeNull();
    expect(headers.get("User-Agent")).toMatch(/Chrome\/131/);
    expect(shouldHideEngineIdentity({ mode: "stealth" })).toBe(true);
  });

  it("does not override user-supplied User-Agent", () => {
    const headers = new Headers({ "User-Agent": "KyreiTest/1.0" });
    applySubscriptionShieldHeaders(headers, "stealth");
    expect(headers.get("User-Agent")).toBe("KyreiTest/1.0");
  });

  it("standard mode stays minimal", () => {
    expect(subscriptionShieldDefaultHeaders("standard")).toEqual({ Accept: "application/json" });
    expect(shouldHideEngineIdentity({ mode: "standard" })).toBe(false);
  });

  it("builds a typed retryable timeout error for header waits", () => {
    expect(createSubscriptionShieldTimeoutError(12_345)).toMatchObject({
      name: "TimeoutError",
      code: "ETIMEDOUT",
      reason: "subscription_shield_timeout",
      phase: "headers",
      timeoutMs: 12_345,
      message: "subscription_shield_timeout",
    });
  });
});

describe("paceSubscriptionRequest", () => {
  it("serializes concurrent starts for the same seat", async () => {
    const order: string[] = [];
    const first = paceSubscriptionRequest("seat-a", 30).then(() => {
      order.push("a");
    });
    const second = paceSubscriptionRequest("seat-a", 30).then(() => {
      order.push("b");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("wrapFetchWithSubscriptionShield", () => {
  it("returns undefined/base when shield is off", () => {
    const base = vi.fn() as unknown as typeof fetch;
    expect(wrapFetchWithSubscriptionShield({ config: { mode: "off" }, baseFetch: base })).toBe(base);
    expect(wrapFetchWithSubscriptionShield({ config: { enabled: false, mode: "stealth" } })).toBeUndefined();
  });

  it("paces and applies stealth headers through a custom base fetch", async () => {
    resetSubscriptionShieldPaceForTests();
    const calls: Array<{ ua: string | null; auth: string | null }> = [];
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        ua: headers.get("User-Agent"),
        auth: headers.get("Authorization"),
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const fetchImpl = wrapFetchWithSubscriptionShield({
      config: { enabled: true, mode: "stealth", minIntervalMs: 0 },
      baseFetch,
      paceKey: "acct-1",
      useShieldDispatcher: false,
    });
    expect(fetchImpl).toBeTypeOf("function");
    await fetchImpl!("https://api.example.com/v1/chat", {
      headers: { Authorization: "Bearer sk-test", "X-Kyrei-Engine": "v2" },
    });
    expect(calls[0]).toMatchObject({
      auth: "Bearer sk-test",
      ua: expect.stringContaining("Chrome/131"),
    });
    // Identity header stripped on the wire.
    const lastInit = (baseFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(lastInit.headers).get("X-Kyrei-Engine")).toBeNull();
  });
});
