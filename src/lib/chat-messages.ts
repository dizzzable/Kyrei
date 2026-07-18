import type { ApprovalPart, MessagePart, ToolPart } from "@/lib/types";

const LEGACY_HEAL_HANDOFF_MARKER = "KYREI_FAILURE_HANDOFF";

export function hasLegacyHealHandoff(text: string): boolean {
  return text.includes(LEGACY_HEAL_HANDOFF_MARKER);
}

/**
 * Older engine builds appended an internal handoff marker and an absolute file
 * path to assistant text. The marker was always the final block, so retain the
 * useful partial answer and remove the private control-plane tail.
 */
export function redactLegacyHealHandoff(text: string): string {
  const markerIndex = text.indexOf(LEGACY_HEAL_HANDOFF_MARKER);
  return markerIndex < 0 ? text : text.slice(0, markerIndex).trimEnd();
}

/**
 * Pure reducers that fold a gateway event's delta into a message's parts.
 * Immutable — always return a new array (adapted from Hermes' chat-messages).
 */

/**
 * Coalesce a streaming delta into the most recent same-type part within the
 * current segment. A segment is bounded by any non-streaming part (a tool
 * call); the opposite streaming channel (text <-> reasoning) is transparent,
 * so a reasoning burst between two content deltas can't shred one sentence
 * into text / reasoning / text. Tool calls open a fresh segment, preserving
 * narration order across steps.
 */
function appendStream(parts: MessagePart[], type: "text" | "reasoning", delta: string): MessagePart[] {
  const next = [...parts];
  for (let i = next.length - 1; i >= 0; i--) {
    const part = next[i];
    if (part.type === type) {
      next[i] = { ...part, text: part.text + delta };
      return next;
    }
    // A tool part closes the segment; keep scanning across the transparent
    // streaming channel only.
    if (part.type !== "text" && part.type !== "reasoning") break;
  }
  next.push(type === "text" ? { type: "text", text: delta } : { type: "reasoning", text: delta });
  return next;
}

export function appendText(parts: MessagePart[], delta: string): MessagePart[] {
  return appendStream(parts, "text", delta);
}

export function appendReasoning(parts: MessagePart[], delta: string): MessagePart[] {
  return appendStream(parts, "reasoning", delta);
}

export function approvalRequest(
  parts: MessagePart[],
  info: {
    approvalId: string;
    toolCallId: string;
    name: string;
    args?: unknown;
    reason: string;
  },
): MessagePart[] {
  const withPausedTool = parts.map(part => part.type === "tool" && part.toolCallId === info.toolCallId
    ? { ...part, running: false, awaitingApproval: true }
    : part);
  const index = withPausedTool.findIndex(part => part.type === "approval" && part.approvalId === info.approvalId);
  const approval: ApprovalPart = {
    type: "approval",
    approvalId: info.approvalId,
    toolCallId: info.toolCallId,
    name: info.name,
    args: info.args,
    reason: info.reason,
    status: "pending",
  };
  if (index < 0) return [...withPausedTool, approval];
  const next = [...withPausedTool];
  next[index] = { ...(withPausedTool[index] as ApprovalPart), ...approval };
  return next;
}

export function approvalResolved(
  parts: MessagePart[],
  info: {
    approvalId: string;
    approved?: boolean;
    reason?: string;
    consumed?: boolean;
  },
): MessagePart[] {
  const index = parts.findIndex(part => part.type === "approval" && part.approvalId === info.approvalId);
  if (index < 0) return parts;
  const current = parts[index] as ApprovalPart;
  const next = [...parts];
  next[index] = {
    ...current,
    ...(typeof info.approved === "boolean" ? { status: info.approved ? "approved" : "denied" } : {}),
    ...(info.reason ? { decisionReason: info.reason } : {}),
    ...(typeof info.approved === "boolean" ? { resolvedAt: current.resolvedAt ?? new Date().toISOString() } : {}),
    ...(info.consumed ? { consumedAt: current.consumedAt ?? new Date().toISOString() } : {}),
  };
  return next;
}

/**
 * Locate the tool part a start/complete event refers to. Prefer the stable
 * `toolCallId`; otherwise fall back to the most recent unfinished part
 * (`result === undefined && error === undefined`) sharing the same name. This
 * keeps parallel calls with distinct ids on separate rows while still letting
 * an id-less completion land on its pending start instead of spawning a dupe.
 */
function findToolIndex(parts: MessagePart[], info: { toolCallId?: string; name?: string }): number {
  // A stable id is authoritative: match it exactly, and never coalesce onto a
  // different call by name — that keeps parallel invocations on separate rows.
  if (info.toolCallId) {
    return parts.findIndex(p => p.type === "tool" && p.toolCallId === info.toolCallId);
  }
  // Id-less events fall back to the most recent unfinished part of the same name.
  if (info.name) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.type === "tool" && p.name === info.name && p.result === undefined && p.error === undefined) {
        return i;
      }
    }
  }
  return -1;
}

export function toolStart(
  parts: MessagePart[],
  info: { toolCallId?: string; name?: string; args?: unknown },
): MessagePart[] {
  // Reuse an existing row for a repeated/late start of the same call so
  // parallel invocations with distinct ids stay separate but redundant starts
  // don't multiply rows.
  const idx = findToolIndex(parts, info);
  if (idx >= 0) {
    const existing = parts[idx] as ToolPart;
    const next = [...parts];
    next[idx] = {
      ...existing,
      name: info.name ?? existing.name,
      args: info.args !== undefined ? info.args : existing.args,
      running: true,
    };
    return next;
  }
  const tool: ToolPart = {
    type: "tool",
    toolCallId: info.toolCallId || `tool-${parts.length}`,
    name: info.name || "tool",
    args: info.args,
    running: true,
  };
  return [...parts, tool];
}

export function toolProgress(
  parts: MessagePart[],
  info: { toolCallId?: string; name?: string; text?: string },
): MessagePart[] {
  const idx = findToolIndex(parts, info);
  if (idx === -1 || !info.text) return parts;
  const existing = parts[idx] as ToolPart;
  const next = [...parts];
  next[idx] = { ...existing, progress: info.text };
  return next;
}

export function toolComplete(
  parts: MessagePart[],
  info: { toolCallId?: string; name?: string; result?: string; error?: string; durationS?: number; inlineDiff?: string; snapshotId?: string },
): MessagePart[] {
  const idx = findToolIndex(parts, info);
  if (idx === -1) return parts;
  const existing = parts[idx] as ToolPart;
  const next = [...parts];
  next[idx] = {
    ...existing,
    running: false,
    result: info.result ?? existing.result,
    error: info.error ?? existing.error,
    durationS: info.durationS ?? existing.durationS,
    inlineDiff: info.inlineDiff ?? existing.inlineDiff,
    snapshotId: info.snapshotId ?? existing.snapshotId,
    progress: undefined,
  };
  return next;
}

export function messageText(parts: MessagePart[]): string {
  return parts
    .filter((p): p is Extract<MessagePart, { type: "text" }> => p.type === "text")
    .map(p => p.text)
    .join("");
}
