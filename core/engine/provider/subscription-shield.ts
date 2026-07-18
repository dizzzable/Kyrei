/**
 * Subscription shield — transport hygiene for expensive API seats.
 *
 * Goals (startup-safe, not free-UI scraping):
 * - Pace per-account bursts so abuse detectors see fewer hammer patterns
 * - Bound concurrent in-flight requests per origin (less handshake stampede)
 * - Optional browser-like headers; strip custom "X-Kyrei-Engine" identity
 * - Optional connect-style abort timeout around each request
 *
 * This is NOT full Chrome JA3 impersonation (needs native/curl-impersonate /
 * a custom TLS stack). Combined with account-pool anti-false-ban it protects
 * paid keys far better than raw unbounded Node fetch alone.
 */

export type SubscriptionShieldMode = "off" | "standard" | "stealth";

export interface SubscriptionShieldConfig {
  /** Master switch (default true — protect paid seats OOB). */
  enabled: boolean;
  /**
   * off = disabled even if enabled flag true
   * standard = pacing + concurrency bound + Accept hygiene
   * stealth = standard + browser-like headers + strip Kyrei identity
   */
  mode: SubscriptionShieldMode;
  /** Minimum gap between request starts for the same pace key (ms). */
  minIntervalMs: number;
  /** Legacy alias for the header timeout; kept for old saved configs. */
  connectTimeoutMs: number;
  /** Timeout while waiting for response headers (ms); 0 disables. */
  headerTimeoutMs: number;
  /** Timeout between raw response body chunks (ms); 0 disables. */
  inactivityTimeoutMs: number;
  /** Max concurrent in-flight requests per origin host. */
  maxConnectionsPerOrigin: number;
}

export interface SubscriptionShieldTimeoutError extends Error {
  code: "ETIMEDOUT";
  reason: "subscription_shield_timeout";
  phase: "headers" | "body-inactivity";
  timeoutMs: number;
}

export const SUBSCRIPTION_SHIELD_MODES: readonly SubscriptionShieldMode[] = [
  "off",
  "standard",
  "stealth",
];

const DEFAULTS: SubscriptionShieldConfig = {
  enabled: true,
  mode: "stealth",
  minIntervalMs: 75,
  connectTimeoutMs: 0,
  headerTimeoutMs: 0,
  inactivityTimeoutMs: 0,
  maxConnectionsPerOrigin: 4,
};

/** Chrome 131-ish desktop UA — stable, widely accepted by CDNs. */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const paceLocks = new Map<string, Promise<void>>();
const paceLastStart = new Map<string, number>();
const originInflight = new Map<string, number>();
const originWaiters = new Map<string, Array<() => void>>();

/** Test hook: clear in-memory pacing / concurrency state. */
export function resetSubscriptionShieldPaceForTests(): void {
  paceLocks.clear();
  paceLastStart.clear();
  originInflight.clear();
  originWaiters.clear();
}

/** No-op kept for API symmetry with earlier undici-based drafts. */
export async function closeSubscriptionShieldDispatcher(): Promise<void> {
  /* pure-fetch shield has no shared native agent */
}

export function normalizeSubscriptionShield(raw: unknown): SubscriptionShieldConfig {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const modeRaw = typeof source.mode === "string" ? source.mode.trim().toLowerCase() : "";
  const mode = SUBSCRIPTION_SHIELD_MODES.includes(modeRaw as SubscriptionShieldMode)
    ? modeRaw as SubscriptionShieldMode
    : DEFAULTS.mode;
  const enabled = source.enabled === false || mode === "off" ? false : source.enabled !== false;
  const legacyTimeoutMs = clampInt(source.connectTimeoutMs, DEFAULTS.connectTimeoutMs, 0, 120_000);
  const headerTimeoutMs = clampInt(source.headerTimeoutMs, legacyTimeoutMs, 0, 120_000);
  const inactivityTimeoutMs = clampInt(source.inactivityTimeoutMs, DEFAULTS.inactivityTimeoutMs, 0, 120_000);
  return {
    enabled: enabled && mode !== "off",
    mode: enabled ? mode : "off",
    minIntervalMs: clampInt(source.minIntervalMs, DEFAULTS.minIntervalMs, 0, 10_000),
    connectTimeoutMs: headerTimeoutMs,
    headerTimeoutMs,
    inactivityTimeoutMs,
    maxConnectionsPerOrigin: clampInt(
      source.maxConnectionsPerOrigin,
      DEFAULTS.maxConnectionsPerOrigin,
      1,
      32,
    ),
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSubscriptionShieldTimeoutError(
  timeoutMs: number,
  phase: SubscriptionShieldTimeoutError["phase"] = "headers",
): SubscriptionShieldTimeoutError {
  return Object.assign(new Error("subscription_shield_timeout"), {
    name: "TimeoutError",
    code: "ETIMEDOUT" as const,
    reason: "subscription_shield_timeout" as const,
    phase,
    timeoutMs,
  });
}

function withResponseBody(response: Response, body: ReadableStream<Uint8Array>): Response {
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const [key, value] of [
    ["url", response.url],
    ["redirected", response.redirected],
    ["type", response.type],
  ] as const) {
    try {
      Object.defineProperty(wrapped, key, { value, configurable: true });
    } catch {
      /* best-effort mirror only */
    }
  }
  return wrapped;
}

/**
 * Serialize + space out starts for one account/seat so parallel tools
 * do not open a burst of TLS sessions that look like abuse.
 */
export async function paceSubscriptionRequest(
  paceKey: string,
  minIntervalMs: number,
  now = Date.now(),
): Promise<void> {
  const key = paceKey.trim() || "default";
  const minGap = Math.max(0, minIntervalMs);
  const previous = paceLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous
    .catch(() => undefined)
    .then(async () => {
      const last = paceLastStart.get(key) ?? 0;
      const wait = Math.max(0, last + minGap - now);
      // Light jitter so many seats do not sync on the same tick.
      const jitter = minGap > 0 ? Math.floor(Math.random() * Math.min(40, minGap)) : 0;
      if (wait + jitter > 0) await sleep(wait + jitter);
      paceLastStart.set(key, Date.now());
    })
    .finally(() => release());
  paceLocks.set(key, chain.then(() => undefined, () => undefined));
  await chain;
}

function originKeyFromInput(input: Parameters<typeof fetch>[0]): string {
  try {
    if (typeof input === "string") return new URL(input).host || "default";
    if (input instanceof URL) return input.host || "default";
    if (input instanceof Request) return new URL(input.url).host || "default";
  } catch {
    /* fall through */
  }
  return "default";
}

async function acquireOriginSlot(origin: string, max: number): Promise<void> {
  const limit = Math.max(1, max);
  const current = originInflight.get(origin) ?? 0;
  if (current < limit) {
    originInflight.set(origin, current + 1);
    return;
  }
  await new Promise<void>((resolve) => {
    const waiters = originWaiters.get(origin) ?? [];
    waiters.push(resolve);
    originWaiters.set(origin, waiters);
  });
  originInflight.set(origin, (originInflight.get(origin) ?? 0) + 1);
}

function releaseOriginSlot(origin: string): void {
  const current = Math.max(0, (originInflight.get(origin) ?? 1) - 1);
  originInflight.set(origin, current);
  const waiters = originWaiters.get(origin);
  const next = waiters?.shift();
  if (next) next();
  if (waiters && waiters.length === 0) originWaiters.delete(origin);
}

/** Headers applied only when missing (user/provider headers always win). */
export function subscriptionShieldDefaultHeaders(mode: SubscriptionShieldMode): Record<string, string> {
  if (mode !== "stealth" && mode !== "standard") return {};
  if (mode === "standard") {
    return {
      Accept: "application/json",
    };
  }
  return {
    "User-Agent": BROWSER_USER_AGENT,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-ch-ua": "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
  };
}

const IDENTITY_HEADERS = ["x-kyrei-engine", "x-kyrei-client", "x-kyrei-agent"];

export function applySubscriptionShieldHeaders(
  headers: Headers,
  mode: SubscriptionShieldMode,
): Headers {
  if (mode === "off") return headers;
  const defaults = subscriptionShieldDefaultHeaders(mode);
  for (const [name, value] of Object.entries(defaults)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (mode === "stealth") {
    for (const name of IDENTITY_HEADERS) headers.delete(name);
  }
  return headers;
}

export interface WrapSubscriptionShieldFetchOpts {
  config: SubscriptionShieldConfig | Record<string, unknown> | unknown;
  /** Defaults to globalThis.fetch. */
  baseFetch?: typeof fetch;
  /** Account or seat id for pacing isolation. */
  paceKey?: string;
  /** Inject a clock for tests. */
  now?: () => number;
  /** Kept for API compatibility; pure-fetch path ignores native dispatchers. */
  useShieldDispatcher?: boolean;
}

/**
 * Returns a fetch that paces seats and applies transport hygiene.
 * When shield is off, returns baseFetch unchanged (or undefined so callers skip).
 */
export function wrapFetchWithSubscriptionShield(
  opts: WrapSubscriptionShieldFetchOpts,
): typeof fetch | undefined {
  const config = normalizeSubscriptionShield(opts.config);
  if (!config.enabled || config.mode === "off") {
    return opts.baseFetch;
  }

  const baseFetch = opts.baseFetch ?? globalThis.fetch.bind(globalThis);
  const paceKey = opts.paceKey ?? "default";

  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    await paceSubscriptionRequest(
      paceKey,
      config.minIntervalMs,
      opts.now?.() ?? Date.now(),
    );

    const origin = originKeyFromInput(input);
    await acquireOriginSlot(origin, config.maxConnectionsPerOrigin);

    const headers = applySubscriptionShieldHeaders(
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      config.mode,
    );

    const headerTimeoutMs = config.headerTimeoutMs;
    const inactivityTimeoutMs = config.inactivityTimeoutMs;
    let headerTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOutPhase: SubscriptionShieldTimeoutError["phase"] | null = null;
    let released = false;
    let bodyOwnsCleanup = false;
    let abortBody: ((reason: unknown) => void) | undefined;
    const releaseOriginSlotOnce = () => {
      if (released) return;
      released = true;
      releaseOriginSlot(origin);
    };
    const controller = headerTimeoutMs > 0 || inactivityTimeoutMs > 0 || init?.signal
      ? new AbortController()
      : null;
    const onExternalAbort = () => {
      const reason = init?.signal?.reason;
      controller?.abort(reason);
      abortBody?.(reason);
    };
    const removeExternalAbort = () => init?.signal?.removeEventListener("abort", onExternalAbort);
    if (init?.signal?.aborted) {
      releaseOriginSlotOnce();
      throw init.signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    init?.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (controller && headerTimeoutMs > 0) {
      headerTimeoutId = setTimeout(() => {
        timedOutPhase = "headers";
        controller.abort(createSubscriptionShieldTimeoutError(headerTimeoutMs, "headers"));
      }, headerTimeoutMs);
    }

    try {
      const responsePromise = baseFetch(input, {
        ...init,
        headers,
        ...(controller ? { signal: controller.signal } : {}),
      });
      const response = controller
        ? await new Promise<Response>((resolve, reject) => {
          const onControllerAbort = () => {
            controller.signal.removeEventListener("abort", onControllerAbort);
            reject(controller.signal.reason);
          };
          controller.signal.addEventListener("abort", onControllerAbort, { once: true });
          responsePromise.then(
            (value) => {
              controller.signal.removeEventListener("abort", onControllerAbort);
              resolve(value);
            },
            (error: unknown) => {
              controller.signal.removeEventListener("abort", onControllerAbort);
              reject(error);
            },
          );
        })
        : await responsePromise;
      if (headerTimeoutId !== undefined) {
        clearTimeout(headerTimeoutId);
        headerTimeoutId = undefined;
      }
      if (!response.body) {
        removeExternalAbort();
        releaseOriginSlotOnce();
        return response;
      }

      const reader = response.body.getReader();
      let bodyTimeoutId: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const cleanupBody = () => {
        if (settled) return false;
        settled = true;
        if (bodyTimeoutId !== undefined) clearTimeout(bodyTimeoutId);
        bodyTimeoutId = undefined;
        removeExternalAbort();
        releaseOriginSlotOnce();
        return true;
      };
      const failBody = (error: unknown) => {
        if (!cleanupBody()) return;
        void reader.cancel(error).catch(() => undefined);
        try { streamController?.error(error); } catch { /* consumer already closed the stream */ }
      };
      abortBody = failBody;
      const armBodyTimeout = () => {
        if (bodyTimeoutId !== undefined) clearTimeout(bodyTimeoutId);
        if (settled || inactivityTimeoutMs <= 0) return;
        bodyTimeoutId = setTimeout(() => {
          timedOutPhase = "body-inactivity";
          failBody(createSubscriptionShieldTimeoutError(inactivityTimeoutMs, "body-inactivity"));
        }, inactivityTimeoutMs);
      };
      const wrappedBody = new ReadableStream<Uint8Array>({
        start(controllerForBody) {
          streamController = controllerForBody;
        },
        async pull(controllerForBody) {
          if (settled) return;
          armBodyTimeout();
          try {
            const { done, value } = await reader.read();
            if (settled) return;
            if (done) {
              if (cleanupBody()) controllerForBody.close();
              return;
            }
            if (bodyTimeoutId !== undefined) clearTimeout(bodyTimeoutId);
            bodyTimeoutId = undefined;
            controllerForBody.enqueue(value);
          } catch (error) {
            if (cleanupBody()) controllerForBody.error(error);
          }
        },
        cancel(reason) {
          return cleanupBody() ? reader.cancel(reason) : undefined;
        },
      });

      bodyOwnsCleanup = true;
      return withResponseBody(response, wrappedBody);
    } catch (error) {
      releaseOriginSlotOnce();
      if (timedOutPhase === "headers") {
        throw Object.assign(createSubscriptionShieldTimeoutError(headerTimeoutMs, "headers"), { cause: error });
      }
      throw error;
    } finally {
      if (headerTimeoutId !== undefined) clearTimeout(headerTimeoutId);
      if (!bodyOwnsCleanup) removeExternalAbort();
    }
  }) as typeof fetch;

  return wrapped;
}

/** Whether buildModel should omit the X-Kyrei-Engine identity header. */
export function shouldHideEngineIdentity(config: SubscriptionShieldConfig | unknown): boolean {
  const normalized = normalizeSubscriptionShield(config);
  return normalized.enabled && normalized.mode === "stealth";
}
