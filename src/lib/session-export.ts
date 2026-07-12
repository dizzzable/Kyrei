import type { ChatMessage, SessionInfo } from "@/lib/types";

import { sessionTitle } from "@/lib/session-search";

/** Shape of a serializable session export. Pure data — the caller is
 *  responsible for turning this into a Blob/download (DOM concerns stay out). */
export interface SessionExport {
  exported_at: string;
  session_id: string;
  title: string;
  message_count: number;
  messages: ChatMessage[];
}

/**
 * Build a plain, JSON-serializable export object for a session.
 *
 * Pure function: it does not touch the DOM, `Blob`, or `URL` — the caller wires
 * the result into a download. Adapted from Hermes' `exportSession` payload,
 * trimmed to our types.
 */
export function buildSessionExport(session: SessionInfo, messages: ChatMessage[]): SessionExport {
  return {
    exported_at: new Date().toISOString(),
    session_id: session.id,
    title: sessionTitle(session),
    message_count: messages.length,
    messages,
  };
}

const REDACTED = "[REDACTED]";

/** Patterns for secret-like tokens. Client-side, best-effort redaction. */
const SECRET_PATTERNS: RegExp[] = [
  // OpenAI-style keys: sk-... (and sk-proj-..., etc.)
  /sk-[A-Za-z0-9_-]{16,}/g,
  // Authorization bearer tokens: "Bearer <token>"
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  // Long hex tokens (e.g. 32+ hex chars) — common for API keys/hashes.
  /\b[0-9a-fA-F]{32,}\b/g,
];

function redactString(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, match =>
      // Preserve the "Bearer " prefix so structure stays readable.
      /^Bearer\s+/i.test(match) ? match.replace(/(Bearer\s+).*/i, `$1${REDACTED}`) : REDACTED,
    );
  }
  return out;
}

/**
 * Recursively mask secret-like values inside any JSON-serializable structure.
 *
 * Returns a new value; the input is not mutated. Only string leaves are
 * inspected — object keys are preserved as-is. Best-effort client-side
 * redaction (`sk-` keys, `Bearer` tokens, long hex tokens).
 */
export function redactSecretsInExport<T>(obj: T): T {
  if (typeof obj === "string") {
    return redactString(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => redactSecretsInExport(item)) as unknown as T;
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      out[key] = redactSecretsInExport(val);
    }
    return out as unknown as T;
  }
  return obj;
}
