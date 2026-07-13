import type { ModelRef, SessionInfo } from "./types";

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
