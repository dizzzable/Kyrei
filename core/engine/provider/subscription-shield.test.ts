import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySubscriptionShieldHeaders,
  closeSubscriptionShieldDispatcher,
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
  it("defaults to inactive so native provider streams own their lifecycle", () => {
    expect(normalizeSubscriptionShield(undefined)).toMatchObject({
      enabled: false,
      mode: "off",
      minIntervalMs: 0,
      headerTimeoutMs: 0,
      inactivityTimeoutMs: 0,
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

  it("neutralizes every persisted legacy transport setting", () => {
    expect(normalizeSubscriptionShield({
      enabled: true,
      mode: "stealth",
      headerTimeoutMs: 11_000,
      inactivityTimeoutMs: 17_000,
      connectTimeoutMs: 29_000,
    })).toMatchObject({
      enabled: false,
      mode: "off",
      minIntervalMs: 0,
      headerTimeoutMs: 0,
      inactivityTimeoutMs: 0,
      connectTimeoutMs: 0,
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
    expect(shouldHideEngineIdentity({ enabled: true, mode: "stealth" })).toBe(false);
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
    expect(wrapFetchWithSubscriptionShield({ config: { enabled: true, mode: "stealth" }, baseFetch: base })).toBe(base);
    expect(wrapFetchWithSubscriptionShield({ config: { enabled: false, mode: "stealth" } })).toBeUndefined();
    expect(wrapFetchWithSubscriptionShield({ config: { enabled: true, mode: "stealth" } })).toBeUndefined();
  });

  it("returns the native provider fetch even when an old shield is enabled", async () => {
    vi.useFakeTimers();
    const baseFetch = vi.fn(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response("{}", { status: 200 })), 75);
    })) as unknown as typeof fetch;
    const fetchImpl = wrapFetchWithSubscriptionShield({
      // 0.7.0 and earlier saved this default for every provider request.
      config: { enabled: true, mode: "stealth", minIntervalMs: 0, connectTimeoutMs: 50 },
      baseFetch,
    });

    const pending = fetchImpl!("https://api.example.com/v1/chat");
    await vi.advanceTimersByTimeAsync(80);
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toBe(baseFetch);
  });

  it("preserves external aborts instead of rewriting them as shield timeouts", async () => {
    const baseFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    ) as unknown as typeof fetch;
    const fetchImpl = wrapFetchWithSubscriptionShield({
      config: { enabled: true, mode: "stealth", minIntervalMs: 0, headerTimeoutMs: 1_000, inactivityTimeoutMs: 1_000 },
      baseFetch,
    });
    const controller = new AbortController();
    const pending = expect(fetchImpl!("https://api.example.com/v1/chat", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
      message: "user canceled",
    });

    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new DOMException("user canceled", "AbortError"));
    await pending;
  });
});
