/**
 * Build persisted MessagePart[] from the response messages, enriched with
 * tool result/diff/duration captured by the stream-bridge. Falls back to the
 * bridge-assembled parts if the response is unavailable (e.g. after abort).
 */

import type { ModelMessage } from "ai";
import type { MessagePart } from "../types.js";
import type { BridgeResult } from "../stream-bridge/bridge.js";

export function toParts(messages: ModelMessage[], bridged: BridgeResult): MessagePart[] {
  const toolByIdEntries = bridged.parts
    .filter((p): p is Extract<MessagePart, { type: "tool" }> => p.type === "tool")
    .map((p) => [p.toolCallId, p] as const);
  const toolById = new Map(toolByIdEntries);

  const out: MessagePart[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
    for (const c of content as Array<Record<string, any>>) {
      const kind = c["type"] as string;
      if (kind === "text") {
        out.push({ type: "text", text: String(c["text"] ?? "") });
      } else if (kind === "reasoning") {
        out.push({ type: "reasoning", text: String(c["text"] ?? "") });
      } else if (kind === "tool-call") {
        const id = String(c["toolCallId"] ?? "");
        const enriched = toolById.get(id);
        out.push({
          type: "tool",
          toolCallId: id,
          name: String(c["toolName"] ?? ""),
          args: c["input"] ?? c["args"],
          result: enriched?.result,
          inlineDiff: enriched?.inlineDiff,
          error: enriched?.error,
          running: false,
          durationS: enriched?.durationS,
        });
      }
    }
  }
  return out.length ? out : bridged.parts;
}
