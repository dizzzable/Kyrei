import type { MessagePart, ToolPart } from "./types";

/**
 * Pure reducers that fold a gateway event's delta into a message's parts.
 * Immutable — always return a new array (adapted from Hermes' chat-messages).
 */

function appendStream(parts: MessagePart[], type: "text" | "reasoning", delta: string): MessagePart[] {
  const next = [...parts];
  // Coalesce into the most recent same-type part within the current segment;
  // a non-stream part (tool) closes the segment and opens a fresh one.
  for (let i = next.length - 1; i >= 0; i--) {
    const part = next[i];
    if (part.type === type) {
      next[i] = { ...part, text: part.text + delta };
      return next;
    }
    if (part.type !== "text" && part.type !== "reasoning") break;
  }
  next.push({ type, text: delta } as MessagePart);
  return next;
}

export function appendText(parts: MessagePart[], delta: string): MessagePart[] {
  return appendStream(parts, "text", delta);
}

export function appendReasoning(parts: MessagePart[], delta: string): MessagePart[] {
  return appendStream(parts, "reasoning", delta);
}

export function toolStart(
  parts: MessagePart[],
  info: { toolCallId?: string; name?: string; args?: unknown },
): MessagePart[] {
  const tool: ToolPart = {
    type: "tool",
    toolCallId: info.toolCallId || `tool-${parts.length}`,
    name: info.name || "tool",
    args: info.args,
    running: true,
  };
  return [...parts, tool];
}

export function toolComplete(
  parts: MessagePart[],
  info: { toolCallId?: string; name?: string; result?: string; error?: string; durationS?: number; inlineDiff?: string },
): MessagePart[] {
  const idx = [...parts].reverse().findIndex(
    p => p.type === "tool" && (info.toolCallId ? p.toolCallId === info.toolCallId : p.running),
  );
  if (idx === -1) return parts;
  const realIdx = parts.length - 1 - idx;
  const existing = parts[realIdx] as ToolPart;
  const next = [...parts];
  next[realIdx] = {
    ...existing,
    running: false,
    result: info.result,
    error: info.error,
    durationS: info.durationS,
    inlineDiff: info.inlineDiff,
  };
  return next;
}

export function messageText(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map(p => p.text)
    .join("");
}
