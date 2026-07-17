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

/** Safe lowercase message/body snippet used only for classification (never logged as-is by callers). */
export function errorMessageOf(err: unknown): string {
  if (!err || typeof err !== "object") return typeof err === "string" ? err : "";
  const source = err as Record<string, any>;
  const parts = [
    source["message"],
    source["code"],
    source["cause"]?.["message"],
    source["cause"]?.["code"],
    source["responseBody"],
    typeof source["data"] === "string" ? source["data"] : source["data"]?.["error"]?.["message"],
    source["data"]?.["message"],
  ];
  return parts.filter((part) => typeof part === "string" && part.trim()).join(" ").toLowerCase();
}

/**
 * Transport / connectivity failures that must never permanently park a seat.
 * OmniRoute / codex-lb style: treat flaky links as short cooldowns only.
 */
const NETWORK_CODE_RE =
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|EPROTO|UND_ERR|ERR_NETWORK|ERR_SOCKET|ERR_TLS|CERT_|socket hang up|network|fetch failed|aborted|timeout|timed out/i;

export function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return typeof err === "string" && NETWORK_CODE_RE.test(err);
  }
  if (statusOf(err) !== undefined) return false;
  const source = err as Record<string, any>;
  if (source["name"] === "AbortError" || source["code"] === "ABORT_ERR") return false;
  const code = String(source["code"] ?? source["cause"]?.["code"] ?? "");
  const msg = errorMessageOf(err);
  return NETWORK_CODE_RE.test(code) || NETWORK_CODE_RE.test(msg);
}

export function isRateLimit(err: unknown): boolean {
  return statusOf(err) === 429;
}

/** Clear credential rejection signals (invalid/revoked key), not CDN/WAF 403 noise. */
const DEFINITE_AUTH_RE =
  /invalid[_\s-]?api[_\s-]?key|incorrect api key|api key (?:is )?(?:invalid|revoked|expired)|unauthorized|authentication[_\s-]?required|invalid[_\s-]?token|token (?:is )?(?:invalid|expired|revoked)|invalid[_\s-]?credentials|credentials? (?:are )?(?:invalid|expired|revoked)|not authenticated|login required|bearer token|x-api-key|permission.?denied|access.?denied|account (?:suspended|disabled|banned|locked)|subscription (?:expired|inactive)|insufficient.?permissions/i;

export function hasDefiniteAuthMessage(err: unknown): boolean {
  return DEFINITE_AUTH_RE.test(errorMessageOf(err));
}

/**
 * Credential-local failure that is safe to route around before semantic output.
 * Soft 403 (WAF/CDN) is excluded so a flaky edge does not look like a ban.
 */
export function isDefiniteAuthFailure(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 401) return true;
  if (status === 403 && hasDefiniteAuthMessage(err)) return true;
  if (status === undefined && hasDefiniteAuthMessage(err) && !isNetworkError(err)) return true;
  return false;
}

/** Ambiguous 403 — often proxy/WAF/geo; prefer cooldown + multi-strike over seat kill. */
export function isSoftAuthFailure(err: unknown): boolean {
  return statusOf(err) === 403 && !hasDefiniteAuthMessage(err);
}

/** True for both definite and soft auth-class responses (key rotation may still help). */
export function isAuthFailure(err: unknown): boolean {
  const status = statusOf(err);
  return status === 401 || status === 403 || isDefiniteAuthFailure(err);
}

export function isServerError(err: unknown): boolean {
  const s = statusOf(err);
  return !!s && s >= 500 && s < 600;
}

export function isRetryable(err: unknown): boolean {
  if (isRateLimit(err) || isServerError(err) || isNetworkError(err)) return true;
  const status = statusOf(err);
  if (status === 408 || status === 425) return true;
  // Soft 403 is transient-friendly; stream/open can retry or hop accounts.
  if (isSoftAuthFailure(err)) return true;
  return false;
}

/**
 * Stable failure class for account-pool anti-false-ban policy.
 * Never include secrets or raw bodies — only the enum.
 */
export type ProviderFailureClass =
  | "network"
  | "rate_limit"
  | "server"
  | "auth_definite"
  | "auth_soft"
  | "client"
  | "unknown";

export function classifyProviderFailure(err: unknown): ProviderFailureClass {
  if (isNetworkError(err)) return "network";
  if (isRateLimit(err)) return "rate_limit";
  if (isServerError(err)) return "server";
  if (isDefiniteAuthFailure(err)) return "auth_definite";
  if (isSoftAuthFailure(err)) return "auth_soft";
  const status = statusOf(err);
  if (status !== undefined && status >= 400 && status < 500) return "client";
  return "unknown";
}

/** Model/provider does not support tools/function-calling. */
export function isToolUnsupported(err: unknown): boolean {
  const s = statusOf(err);
  if (![400, 404, 422].includes(s ?? 0)) return false;
  const e = err as Record<string, any>;
  const msg = String(e?.["message"] ?? e?.["responseBody"] ?? e?.["data"] ?? "").toLowerCase();
  return /tool|function|tool_choice|not supported|unknown parameter|unsupported/.test(msg);
}
