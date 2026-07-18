import type { ChatMessage, ModelRef, SessionInfo } from "./types";

export type SessionRunState = "idle" | "running" | "stopping";

export interface CancelResponseLike {
  ok: boolean;
  cancelled?: boolean;
  status?: "cancelled" | "idle" | "interrupted" | "timeout";
}

/** Preserve a local stopping state while the server still reports active work. */
export function runStateForSession(
  status: SessionInfo["status"],
  current: SessionRunState,
): SessionRunState {
  if (status === "working") return current === "stopping" ? "stopping" : "running";
  return "idle";
}

/** Older gateways returned only `{ ok: true }`; that is not proof of cancellation. */
export function cancelResponseIsTerminal(response: CancelResponseLike): boolean {
  return response.cancelled === true
    || response.status === "cancelled"
    || response.status === "idle"
    || response.status === "interrupted";
}

/** Stable local id used to resume an in-flight assistant stream after reselect/reconnect. */
export function pendingAssistantId(sessionId: string): string {
  return `assistant-active-${sessionId}`;
}

export interface SessionHydration {
  messages: ChatMessage[];
  pendingId: string | null;
}

/**
 * Hydration may race with SSE. Keep the live pending frame (and its deltas)
 * after replacing durable history; create it when the stream started before
 * this renderer subscribed.
 */
export function mergeSessionHydration(
  durable: readonly ChatMessage[],
  live: readonly ChatMessage[],
  localPendingId: string,
  active: boolean,
  canonicalPendingId?: string,
): SessionHydration {
  if (!active) {
    return {
      messages: durable.map((message) => ({ ...message })),
      pendingId: null,
    };
  }

  const canonicalId = canonicalPendingId
    ?? durable.find((message) => message.role === "assistant" && message.pending)?.id;
  const livePending = live.find((message) => message.id === localPendingId && message.pending)
    ?? live.find((message) => message.role === "assistant" && message.pending);
  const durablePending = canonicalId
    ? durable.find((message) => message.id === canonicalId)
    : undefined;
  const pendingId = canonicalId ?? livePending?.id ?? localPendingId;
  const pending: ChatMessage = durablePending
    ? {
        ...durablePending,
        id: pendingId,
        parts: livePending?.parts.length ? livePending.parts : durablePending.parts,
        pending: true,
      }
    : livePending
      ? { ...livePending, id: pendingId, pending: true }
      : {
      id: pendingId,
      role: "assistant" as const,
      parts: [],
      pending: true,
    };

  const messages = durable
    .filter((message) => message.id !== localPendingId || message.id === pendingId)
    .map((message) => message.id === pendingId ? pending : { ...message });
  if (!messages.some((message) => message.id === pendingId)) messages.push(pending);
  return { messages, pendingId };
}

export interface SessionPollSnapshot {
  requestId: number;
  latestRequestId: number;
  revisionAtStart: number;
  currentRevision: number;
  mutationsInFlight: number;
}

/** A poll may update session state only when it is both current and mutation-free. */
export function shouldApplySessionPoll(snapshot: SessionPollSnapshot): boolean {
  return snapshot.requestId === snapshot.latestRequestId
    && snapshot.revisionAtStart === snapshot.currentRevision
    && snapshot.mutationsInFlight === 0;
}

/** Keep the selected session when possible and fall back after remote deletion. */
export function reconcileCurrentSessionId(
  currentId: string | null,
  remoteSessions: readonly Pick<SessionInfo, "id">[],
): string | null {
  if (currentId === null) return null;
  if (remoteSessions.some((session) => session.id === currentId)) return currentId;
  return remoteSessions[0]?.id ?? null;
}

/** Apply a session-local model target without affecting the global default. */
export function updateSessionModel(
  sessions: readonly SessionInfo[],
  sessionId: string,
  target: ModelRef,
): SessionInfo[] {
  return sessions.map((session) => session.id === sessionId ? { ...session, ...target } : session);
}

/** Undo a failed optimistic target unless a newer selection has already won. */
export function rollbackSessionModel(
  sessions: readonly SessionInfo[],
  sessionId: string,
  optimistic: ModelRef,
  previous: ModelRef,
): SessionInfo[] {
  return sessions.map((session) => session.id === sessionId
    && session.providerId === optimistic.providerId
    && session.modelId === optimistic.modelId
    ? { ...session, ...previous }
    : session);
}
