/**
 * Subscription shield — transport hygiene for expensive API seats.
 *
 * Deprecated compatibility surface for old persisted settings. Kyrei no
 * longer wraps provider streams with pacing, header mutation, or deadlines.
 * A provider owns its stream lifecycle; Kyrei only accepts an explicit user
 * cancellation or a genuine upstream transport failure.
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
  /** Legacy persisted field. It is always normalized to zero. */
  connectTimeoutMs: number;
  /** Legacy deadline. It is always normalized to zero. */
  headerTimeoutMs: number;
  /** Legacy stream watchdog. It is always normalized to zero. */
  inactivityTimeoutMs: number;
  /** Max concurrent in-flight requests per origin host. */
  maxConnectionsPerOrigin: number;
}

export const SUBSCRIPTION_SHIELD_MODES: readonly SubscriptionShieldMode[] = [
  "off",
  "standard",
  "stealth",
];

const DEFAULTS: SubscriptionShieldConfig = {
  enabled: false,
  mode: "off",
  minIntervalMs: 0,
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

/** Test hook: clear legacy in-memory pacing state. */
export function resetSubscriptionShieldPaceForTests(): void {
  paceLocks.clear();
  paceLastStart.clear();
}

/** No-op kept for API symmetry with earlier undici-based drafts. */
export async function closeSubscriptionShieldDispatcher(): Promise<void> {
  /* pure-fetch shield has no shared native agent */
}

export function normalizeSubscriptionShield(raw: unknown): SubscriptionShieldConfig {
  // Read and discard the legacy value so old settings continue to deserialize
  // without ever restoring a hidden request deadline or stream watchdog.
  void raw;
  return { ...DEFAULTS };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Legacy no-op: callers always receive the provider-native fetch unchanged. */
export function wrapFetchWithSubscriptionShield(
  opts: WrapSubscriptionShieldFetchOpts,
): typeof fetch | undefined {
  // Never interpose Kyrei between a provider SDK and its streaming response.
  // In particular, do not create a controller or install a timer here: an
  // upstream stream has the sole authority to report a transport failure.
  void opts.config;
  void opts.paceKey;
  void opts.now;
  void opts.useShieldDispatcher;
  return opts.baseFetch;
}

/** Whether buildModel should omit the X-Kyrei-Engine identity header. */
export function shouldHideEngineIdentity(config: SubscriptionShieldConfig | unknown): boolean {
  const normalized = normalizeSubscriptionShield(config);
  return normalized.enabled && normalized.mode === "stealth";
}
