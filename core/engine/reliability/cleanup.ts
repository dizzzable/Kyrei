/**
 * Remove dangling tool pairs so history stays valid for the next request.
 * Requirements §9.2, Property 5/14.
 *
 * - Drops assistant tool-call parts that have no matching tool-result.
 * - Drops orphan tool-result messages that have no matching tool-call.
 * - Drops assistant messages that become empty after pruning.
 */

import type { ModelMessage } from "ai";

export function cleanupIncomplete(messages: ModelMessage[]): ModelMessage[] {
  const resultIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && Array.isArray(m.content)) {
      for (const p of m.content as unknown as Array<Record<string, unknown>>) {
        if (p["type"] === "tool-result" && p["toolCallId"]) resultIds.add(String(p["toolCallId"]));
      }
    }
  }

  const callIds = new Set<string>();
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const parts = m.content as unknown as Array<Record<string, unknown>>;
      const kept = parts.filter((p) => p["type"] !== "tool-call" || resultIds.has(String(p["toolCallId"])));
      for (const p of kept) if (p["type"] === "tool-call") callIds.add(String(p["toolCallId"]));
      if (kept.length === 0 && parts.length > 0) continue; // was tool-only, now empty → drop
      out.push(kept.length === parts.length ? m : ({ ...m, content: kept } as unknown as ModelMessage));
    } else if (m.role === "tool" && Array.isArray(m.content)) {
      const parts = m.content as unknown as Array<Record<string, unknown>>;
      const kept = parts.filter((p) => p["type"] !== "tool-result" || callIds.has(String(p["toolCallId"])));
      if (kept.length === 0 && parts.length > 0) continue;
      out.push(kept.length === parts.length ? m : ({ ...m, content: kept } as unknown as ModelMessage));
    } else {
      out.push(m);
    }
  }
  return out;
}
