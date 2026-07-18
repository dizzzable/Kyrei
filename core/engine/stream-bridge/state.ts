import type { MessagePart, Usage } from "../types.js";

export interface ToolInFlight {
  id: string;
  name: string;
  args?: unknown;
  startedAt: number;
  inlineDiff?: string;
  snapshotId?: string;
  result?: string;
  error?: string;
}

export interface BridgeState {
  text: string;
  parts: MessagePart[];
  tools: Map<string, ToolInFlight>;
  usage?: Usage;
  aborted: boolean;
  errored: boolean;
  stepCount: number;
  finished: boolean;
  pendingApprovals: number;
  nextReasoningSequence: number;
  nextReasoningId: number;
  activeReasoning?: {
    id: string;
    source: "provider" | "kyrei-status";
    providerId?: string;
    modelId?: string;
    attempt?: number;
    startedAt: number;
    sequence: number;
  };
}

export function initState(): BridgeState {
  return {
    text: "",
    parts: [],
    tools: new Map(),
    aborted: false,
    errored: false,
    stepCount: 0,
    finished: false,
    pendingApprovals: 0,
    nextReasoningSequence: 0,
    nextReasoningId: 0,
  };
}

export function pushText(st: BridgeState, delta: string): void {
  st.text += delta;
  const last = st.parts[st.parts.length - 1];
  if (last && last.type === "text") last.text += delta;
  else st.parts.push({ type: "text", text: delta });
}

export function nextReasoningSequence(st: BridgeState): number {
  st.nextReasoningSequence += 1;
  return st.nextReasoningSequence;
}

export function openReasoning(
  st: BridgeState,
  info: {
    id?: string;
    source: "provider" | "kyrei-status";
    providerId?: string;
    modelId?: string;
    attempt?: number;
    startedAt?: number;
  },
): NonNullable<BridgeState["activeReasoning"]> {
  const active = {
    id: info.id?.trim() || `reasoning-${++st.nextReasoningId}`,
    source: info.source,
    providerId: info.providerId,
    modelId: info.modelId,
    attempt: info.attempt,
    startedAt: info.startedAt ?? Date.now(),
    sequence: nextReasoningSequence(st),
  } as const;
  st.activeReasoning = active;
  return active;
}

export function pushReasoning(
  st: BridgeState,
  delta: string,
  info?: {
    id?: string;
    source?: "provider" | "kyrei-status";
    providerId?: string;
    modelId?: string;
    attempt?: number;
    startedAt?: number;
    sequence?: number;
  },
): NonNullable<BridgeState["activeReasoning"]> | undefined {
  if (!delta) return st.activeReasoning;
  const active = st.activeReasoning?.id === info?.id || !info?.id
    ? st.activeReasoning ?? openReasoning(st, {
      id: info?.id,
      source: info?.source ?? "provider",
      providerId: info?.providerId,
      modelId: info?.modelId,
      attempt: info?.attempt,
      startedAt: info?.startedAt,
    })
    : openReasoning(st, {
      id: info?.id,
      source: info?.source ?? "provider",
      providerId: info?.providerId,
      modelId: info?.modelId,
      attempt: info?.attempt,
      startedAt: info?.startedAt,
    });
  if (!active) return undefined;
  const sequence = info?.sequence ?? nextReasoningSequence(st);
  const last = st.parts[st.parts.length - 1];
  if (last && last.type === "reasoning" && last.id === active.id) {
    last.text += delta;
    last.sequence = sequence;
    last.state = "streaming";
    return active;
  }
  st.parts.push({
    type: "reasoning",
    id: active.id,
    source: active.source,
    providerId: active.providerId,
    modelId: active.modelId,
    attempt: active.attempt,
    text: delta,
    state: "streaming",
    startedAt: active.startedAt,
    sequence,
  });
  return active;
}

export function closeReasoning(
  st: BridgeState,
  info?: {
    id?: string;
    state?: "complete" | "redacted" | "interrupted";
    completedAt?: number;
    sequence?: number;
  },
): { id: string; sequence: number; completedAt: number } | undefined {
  const active = st.activeReasoning;
  const targetId = info?.id ?? active?.id;
  if (!targetId) return undefined;
  const part = [...st.parts].reverse().find((entry): entry is Extract<MessagePart, { type: "reasoning" }> =>
    entry.type === "reasoning" && entry.id === targetId,
  );
  const sequence = info?.sequence ?? nextReasoningSequence(st);
  const completedAt = info?.completedAt ?? Date.now();
  if (part) {
    part.state = info?.state ?? "complete";
    part.completedAt = completedAt;
    part.sequence = sequence;
  }
  if (active?.id === targetId) st.activeReasoning = undefined;
  return { id: targetId, sequence, completedAt };
}
