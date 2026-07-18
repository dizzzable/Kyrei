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

  it("accepts explicit header/inactivity timeouts and 0 disables them", () => {
    expect(normalizeSubscriptionShield({
      headerTimeoutMs: 11_000,
      inactivityTimeoutMs: 17_000,
      connectTimeoutMs: 29_000,
    })).toMatchObject({
      headerTimeoutMs: 11_000,
      inactivityTimeoutMs: 17_000,
    });
    expect(normalizeSubscriptionShield({
      connectTimeoutMs: 0,
      inactivityTimeoutMs: 0,
    })).toMatchObject({
      headerTimeoutMs: 0,
      inactivityTimeoutMs: 0,
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

  it("times out while waiting for response headers", async () => {
    vi.useFakeTimers();
    const baseFetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;
    const fetchImpl = wrapFetchWithSubscriptionShield({
      config: { enabled: true, mode: "stealth", minIntervalMs: 0, headerTimeoutMs: 50, inactivityTimeoutMs: 0 },
      baseFetch,
    });

    const pending = expect(fetchImpl!("https://api.example.com/v1/chat")).rejects.toMatchObject({
      code: "ETIMEDOUT",
      phase: "headers",
      timeoutMs: 50,
    });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(60);
    await pending;
  });

  it("times out on silent response bodies after headers", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // stay silent forever
      },
    });
    const baseFetch = vi.fn(async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;
    const fetchImpl = wrapFetchWithSubscriptionShield({
      config: { enabled: true, mode: "stealth", minIntervalMs: 0, headerTimeoutMs: 0, inactivityTimeoutMs: 50 },
      baseFetch,
    });

    const response = await fetchImpl!("https://api.example.com/v1/chat");
    const reader = response.body!.getReader();
    const pending = expect(reader.read()).rejects.toMatchObject({
      code: "ETIMEDOUT",
      phase: "body-inactivity",
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(60);
    await pending;
  });

  it("refreshes inactivity timeout on every raw body chunk including SSE heartbeats", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
      },
    });
    const baseFetch = vi.fn(async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;
    const fetchImpl = wrapFetchWithSubscriptionShield({
      config: { enabled: true, mode: "stealth", minIntervalMs: 0, headerTimeoutMs: 0, inactivityTimeoutMs: 50 },
      baseFetch,
    });

    const response = await fetchImpl!("https://api.example.com/v1/chat");
    const reader = response.body!.getReader();
    const firstRead = reader.read();
    controller.enqueue(new TextEncoder().encode(": ping\n\n"));
    await expect(firstRead).resolves.toMatchObject({ done: false });

    await vi.advanceTimersByTimeAsync(40);
    const secondRead = reader.read();
    controller.enqueue(new TextEncoder().encode("data: ok\n\n"));
    await expect(secondRead).resolves.toMatchObject({ done: false });

    const thirdRead = reader.read();
    await vi.advanceTimersByTimeAsync(40);
    controller.close();
    await expect(thirdRead).resolves.toMatchObject({ done: true });
  });

  it("keeps the origin slot busy until the response body is finished", async () => {
    vi.useFakeTimers();
    const firstBody = new ReadableStream<Uint8Array>({
      start() {
        // kept open until the wrapped consumer cancels it
      },
    });
    const secondBody = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new Uint8Array([1]));
        ctrl.close();
      },
    });
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(firstBody, { status: 200 }))
      .mockResolvedValueOnce(new Response(secondBody, { status: 200 })) as unknown as typeof fetch;
    const fetchImpl = wrapFetchWithSubscriptionShield({
      config: { enabled: true, mode: "stealth", minIntervalMs: 0, headerTimeoutMs: 0, inactivityTimeoutMs: 0, maxConnectionsPerOrigin: 1 },
      baseFetch,
    });

    const firstResponse = await fetchImpl!("https://api.example.com/v1/chat");
    const secondPending = fetchImpl!("https://api.example.com/v1/chat");
    await Promise.resolve();
    expect((baseFetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    await firstResponse.body!.cancel();
    await vi.runAllTimersAsync();
    await secondPending;
    expect((baseFetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
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
