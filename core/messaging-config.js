/**
 * Opt-in inbound messaging channel (webhook). Generic HTTP ingress that can
 * create/append a chat session — no Slack/Telegram SDK required.
 * External platform adapters can reuse the same ingress contract later.
 */

import { randomBytes } from "node:crypto";

const MAX_BODY = 20_000;
const MIN_BODY = 1_000;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeMessagingConfig(source) {
  const s = object(source);
  const maxBodyChars = Number.isFinite(s.maxBodyChars)
    ? Math.min(MAX_BODY, Math.max(MIN_BODY, Math.trunc(s.maxBodyChars)))
    : 8_000;
  return {
    enabled: s.enabled === true,
    autoRun: s.autoRun === true,
    maxBodyChars,
  };
}

/**
 * Public, secret-free messaging status for Settings / activity.
 * @param {object} messaging normalizeMessagingConfig result
 * @param {object} secrets gateway secrets bag
 * @param {Array} recent recent inbound events (in-memory)
 */
export function publicMessagingStatus(messaging, secrets, recent = []) {
  const cfg = normalizeMessagingConfig(messaging);
  const token = typeof secrets?.messaging?.webhookToken === "string"
    ? secrets.messaging.webhookToken.trim()
    : "";
  return {
    enabled: cfg.enabled,
    autoRun: cfg.autoRun,
    maxBodyChars: cfg.maxBodyChars,
    hasToken: token.length >= 16,
    recent: (Array.isArray(recent) ? recent : []).slice(0, 20).map((entry) => ({
      id: entry.id,
      at: entry.at,
      channel: entry.channel ?? "webhook",
      sessionId: entry.sessionId,
      preview: typeof entry.preview === "string" ? entry.preview.slice(0, 120) : "",
      autoRun: Boolean(entry.autoRun),
      status: entry.status ?? "accepted",
    })),
    note: cfg.enabled
      ? "POST /api/messaging/inbound with Authorization: Bearer <token> and JSON { text, sessionId? }."
      : "Enable inbound webhook messaging to accept external prompts into a session.",
  };
}

export function generateMessagingToken() {
  // 32 bytes hex — enough entropy for local loopback / reverse-proxy webhooks
  return randomBytes(32).toString("hex");
}
