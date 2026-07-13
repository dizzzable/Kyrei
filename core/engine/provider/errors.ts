/** Provider error classification (Phase 3). Requirements §7.3, §7.5. */

export function statusOf(err: unknown): number | undefined {
  const e = err as Record<string, any> | null;
  const raw = e?.["statusCode"] ?? e?.["status"] ?? e?.["response"]?.["status"] ?? e?.["data"]?.["statusCode"];
  const status = Number(raw);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

function retryAfterValue(headers: unknown): unknown {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    return getter.call(headers, "retry-after");
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (name.toLowerCase() === "retry-after") return value;
  }
  return undefined;
}

function parseRetryAfter(value: unknown, now: number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.floor(value * 1_000));
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const candidate = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(candidate)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.floor(Number(candidate) * 1_000)));
  }
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - now));
}

/** Extract only the safe Retry-After duration; never return arbitrary headers. */
export function retryAfterMsOf(err: unknown, now = Date.now()): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const source = err as Record<string, any>;
  const explicitMs = Number(source["retryAfterMs"]);
  if (Number.isFinite(explicitMs) && explicitMs >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.floor(explicitMs));
  }
  const direct = parseRetryAfter(source["retryAfter"], now);
  if (direct !== undefined) return direct;
  for (const headers of [source["headers"], source["response"]?.["headers"], source["data"]?.["headers"]]) {
    const parsed = parseRetryAfter(retryAfterValue(headers), now);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function isRateLimit(err: unknown): boolean {
  return statusOf(err) === 429;
}

/** Credential-local failure that is safe to route around before semantic output. */
export function isAuthFailure(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403;
}

export function isServerError(err: unknown): boolean {
  const s = statusOf(err);
  return !!s && s >= 500 && s < 600;
}

export function isRetryable(err: unknown): boolean {
  if (isRateLimit(err) || isServerError(err)) return true;
  const msg = String((err as Record<string, any>)?.["message"] ?? "");
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang up/i.test(msg);
}

/** Model/provider does not support tools/function-calling. */
export function isToolUnsupported(err: unknown): boolean {
  const s = statusOf(err);
  if (![400, 404, 422].includes(s ?? 0)) return false;
  const e = err as Record<string, any>;
  const msg = String(e?.["message"] ?? e?.["responseBody"] ?? e?.["data"] ?? "").toLowerCase();
  return /tool|function|tool_choice|not supported|unknown parameter|unsupported/.test(msg);
}
