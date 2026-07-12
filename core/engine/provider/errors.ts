/** Provider error classification (Phase 3). Requirements §7.3, §7.5. */

export function statusOf(err: unknown): number | undefined {
  const e = err as Record<string, any> | null;
  return e?.["statusCode"] ?? e?.["status"] ?? e?.["response"]?.["status"] ?? e?.["data"]?.["statusCode"];
}

export function isRateLimit(err: unknown): boolean {
  return statusOf(err) === 429;
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
