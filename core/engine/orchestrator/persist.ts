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
  const approvalById = new Map(
    bridged.parts
      .filter((p): p is Extract<MessagePart, { type: "approval" }> => p.type === "approval")
      .map((p) => [p.approvalId, p] as const),
  );
  const approvalToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-request" && !part.isAutomatic) {
        approvalToolCallIds.add(part.toolCallId);
      }
    }
  }

  const out: MessagePart[] = [];
  const emittedToolIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && Array.isArray(m.content)) {
      for (const item of m.content) {
        if (item.type !== "tool-result") continue;
        const enriched = toolById.get(item.toolCallId);
        if (!enriched || emittedToolIds.has(item.toolCallId)) continue;
        out.push({ ...enriched });
        emittedToolIds.add(item.toolCallId);
      }
      continue;
    }
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
          snapshotId: enriched?.snapshotId,
          error: enriched?.error,
          running: false,
          awaitingApproval: approvalToolCallIds.has(id),
          durationS: enriched?.durationS,
        });
        emittedToolIds.add(id);
      } else if (kind === "tool-approval-request" && c["isAutomatic"] !== true) {
        const approvalId = String(c["approvalId"] ?? "");
        const enriched = approvalById.get(approvalId);
        if (enriched) out.push({ ...enriched });
      }
    }
  }
  return out.length ? out : bridged.parts;
}
