/**
 * Wave D2 — re-pin active working state at the end of model context.
 * Mitigates lost-in-the-middle / context rot without rewriting chat SoT.
 */

import type { ModelMessage } from "ai";
import { extractFocusTerms, lastUserTextFromMessages } from "./goal-skim.js";

const PIN_MARKER = "[Kyrei working state — re-pinned]";

export function isWorkingStatePinMessage(message: ModelMessage): boolean {
  if (message.role !== "user") return false;
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((p) => (typeof p === "string" ? p : (p as { text?: string }).text ?? "")).join("")
      : "";
  return text.includes(PIN_MARKER);
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * Build a short pin from recent history. Safe to append as the last user message
 * for the *model projection only* (not persisted to chat UI SoT).
 */
export function buildWorkingStatePin(
  messages: ReadonlyArray<ModelMessage>,
  opts: { goal?: string; maxChars?: number } = {},
): string {
  const maxChars = Math.max(200, opts.maxChars ?? 900);
  const goal = (opts.goal ?? lastUserTextFromMessages(messages)).trim();
  const focus = extractFocusTerms(goal, 12).slice(0, 10);

  const open: string[] = [];
  const failed: string[] = [];
  for (let i = Math.max(0, messages.length - 16); i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role === "tool") continue;
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => (typeof p === "string" ? p : (p as { text?: string }).text ?? "")).join("\n")
        : "";
    if (!text) continue;
    for (const line of text.split("\n")) {
      if (/^(TODO|FIXME|OPEN|NEXT|Gap:|Remaining:)/i.test(line.trim())) {
        open.push(clip(line, 120));
      }
      if (/\b(failed|error|denied|blocked|ENOT|EPERM|TypeError|ReferenceError)\b/i.test(line)
        && line.length < 200) {
        failed.push(clip(line, 120));
      }
    }
  }

  const lines = [
    PIN_MARKER,
    goal ? `Goal: ${clip(goal, 320)}` : "Goal: (see recent user turns)",
    focus.length ? `Focus terms: ${focus.join(", ")}` : "",
    open.length ? `Open threads: ${open.slice(-4).join(" · ")}` : "",
    failed.length ? `Recent failures: ${failed.slice(-3).join(" · ")}` : "",
    "Constraints: stay in workspace; surgical diffs; verify with tools before claiming done.",
  ].filter(Boolean);

  let body = lines.join("\n");
  if (body.length > maxChars) body = body.slice(0, maxChars);
  return body;
}

/** Strip previous pins then append a fresh one (idempotent). */
export function withWorkingStatePin(
  messages: ModelMessage[],
  opts: { goal?: string; maxChars?: number } = {},
): ModelMessage[] {
  const base = messages.filter((m) => !isWorkingStatePinMessage(m));
  const pin = buildWorkingStatePin(base, opts);
  return [
    ...base,
    { role: "user", content: pin },
  ];
}
