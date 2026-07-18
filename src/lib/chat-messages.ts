import type { ApprovalPart, MessagePart, ReasoningPart, ToolPart } from "@/lib/types";

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

function appendTextPart(parts: MessagePart[], delta: string): MessagePart[] {
  if (!delta) return parts;
  const next = [...parts];
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const part = next[index];
    if (part.type === "text") {
      next[index] = { ...part, text: part.text + delta };
      return next;
    }
    if (part.type !== "reasoning" || part.id) break;
  }
  return [...parts, { type: "text", text: delta }];
}

function nextReasoningState(
  current: ReasoningPart | undefined,
  update: Partial<ReasoningPart> & Pick<ReasoningPart, "id">,
): ReasoningPart {
  return {
    type: "reasoning",
    text: current?.text ?? "",
    source: current?.source ?? "provider",
    state: current?.state ?? "streaming",
    ...current,
    ...update,
  };
}

function reasoningIndex(parts: MessagePart[], id: string | undefined): number {
  if (!id) return -1;
  return parts.findIndex((part) => part.type === "reasoning" && part.id === id);
}

export function appendText(parts: MessagePart[], delta: string): MessagePart[] {
  return appendTextPart(parts, delta);
}

export function startReasoning(
  parts: MessagePart[],
  info: Pick<ReasoningPart, "id"> & Partial<ReasoningPart>,
): MessagePart[] {
  const idx = reasoningIndex(parts, info.id);
  if (idx < 0) return parts;
  const next = [...parts];
  next[idx] = nextReasoningState(next[idx] as ReasoningPart, {
    ...info,
    state: "streaming",
  });
  return next;
}

export function appendReasoning(
  parts: MessagePart[],
  delta: string,
  info: Partial<ReasoningPart> & { id?: string; sequence?: number } = {},
): MessagePart[] {
  if (!delta) return parts;
  const idx = reasoningIndex(parts, info.id);
  if (idx >= 0) {
    const current = parts[idx] as ReasoningPart;
    if (typeof info.sequence === "number" && typeof current.sequence === "number" && info.sequence <= current.sequence) {
      return parts;
    }
    const last = parts.at(-1);
    if (last?.type !== "reasoning" || last.id !== current.id) return parts;
    const next = [...parts];
    next[idx] = nextReasoningState(current, {
      ...info,
      id: current.id,
      text: current.text + delta,
      state: "streaming",
    });
    return next;
  }
  const last = parts.at(-1);
  if (last?.type === "reasoning" && !last.id && !info.id) {
    return [...parts.slice(0, -1), { ...last, text: last.text + delta, state: "streaming" }];
  }
  return [
    ...parts,
    nextReasoningState(undefined, {
      ...info,
      id: info.id,
      text: delta,
      state: "streaming",
    }),
  ];
}

export function completeReasoning(
  parts: MessagePart[],
  info: Pick<ReasoningPart, "id"> & Partial<ReasoningPart>,
): MessagePart[] {
  const idx = reasoningIndex(parts, info.id);
  if (idx < 0) return parts;
  const current = parts[idx] as ReasoningPart;
  if (typeof info.sequence === "number" && typeof current.sequence === "number" && info.sequence <= current.sequence) {
    return parts;
  }
  const next = [...parts];
  next[idx] = nextReasoningState(current, {
    ...info,
    state: info.state ?? "complete",
  });
  if (!next[idx].text.trim()) return next.filter((_, partIndex) => partIndex !== idx);
  return next;
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
