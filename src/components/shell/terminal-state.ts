import type { TerminalSessionEvent, TerminalSessionSnapshot } from "@/lib/desktop";

const MAX_RENDERER_OUTPUT_CHARS = 262_144;

export interface TerminalViewState {
  ownerId: string;
  sessions: TerminalSessionSnapshot[];
  activeId: string | null;
}

export type TerminalViewAction =
  | { type: "hydrate"; ownerId: string; sessions: TerminalSessionSnapshot[] }
  | { type: "event"; event: TerminalSessionEvent }
  | { type: "activate"; sessionId: string }
  | { type: "ensure"; session: TerminalSessionSnapshot }
  | { type: "rename"; sessionId: string; title: string };

export function emptyTerminalState(ownerId: string): TerminalViewState {
  return { ownerId, sessions: [], activeId: null };
}

function replaceSession(sessions: TerminalSessionSnapshot[], next: TerminalSessionSnapshot) {
  const index = sessions.findIndex((session) => session.id === next.id);
  if (index < 0) return [...sessions, next];
  return sessions.map((session, candidate) => candidate === index ? next : session);
}

function appendChunk(session: TerminalSessionSnapshot, event: Extract<TerminalSessionEvent, { type: "output" }>) {
  const output = [...session.output, { stream: event.stream, text: event.text }];
  let total = output.reduce((sum, chunk) => sum + chunk.text.length, 0);
  while (total > MAX_RENDERER_OUTPUT_CHARS && output.length > 1) {
    const removed = output.shift();
    total -= removed?.text.length ?? 0;
  }
  if (total > MAX_RENDERER_OUTPUT_CHARS && output.length === 1) {
    output[0] = { ...output[0], text: output[0].text.slice(-MAX_RENDERER_OUTPUT_CHARS) };
  }
  return { ...session, output, updatedAt: event.updatedAt };
}

export function terminalViewReducer(state: TerminalViewState, action: TerminalViewAction): TerminalViewState {
  if (action.type === "hydrate") {
    const sessions = action.sessions.filter((session) => session.ownerId === action.ownerId);
    const preserved = action.ownerId === state.ownerId && sessions.some((session) => session.id === state.activeId)
      ? state.activeId
      : sessions[0]?.id ?? null;
    return { ownerId: action.ownerId, sessions, activeId: preserved };
  }
  if (action.type === "activate") {
    return state.sessions.some((session) => session.id === action.sessionId)
      ? { ...state, activeId: action.sessionId }
      : state;
  }
  if (action.type === "ensure") {
    if (action.session.ownerId !== state.ownerId) return state;
    return state.sessions.some((session) => session.id === action.session.id)
      ? state
      : { ...state, sessions: [...state.sessions, action.session], activeId: state.activeId ?? action.session.id };
  }
  if (action.type === "rename") {
    return state.sessions.some((session) => session.id === action.sessionId)
      ? {
          ...state,
          sessions: state.sessions.map((session) => session.id === action.sessionId
            ? { ...session, title: action.title }
            : session),
        }
      : state;
  }

  const event = action.event;
  if (event.type === "closed") {
    if (event.ownerId !== state.ownerId) return state;
    const closedIndex = state.sessions.findIndex((session) => session.id === event.sessionId);
    const sessions = state.sessions.filter((session) => session.id !== event.sessionId);
    return {
      ...state,
      sessions,
      activeId: state.activeId === event.sessionId
        ? sessions[Math.min(Math.max(closedIndex, 0), sessions.length - 1)]?.id ?? null
        : state.activeId,
    };
  }
  if (event.type === "output") {
    const target = state.sessions.find((session) => session.id === event.sessionId);
    if (!target) return state;
    return { ...state, sessions: replaceSession(state.sessions, appendChunk(target, event)) };
  }
  if (event.session.ownerId !== state.ownerId) return state;
  return {
    ...state,
    sessions: replaceSession(state.sessions, event.session),
    activeId: state.activeId ?? event.session.id,
  };
}

export { MAX_RENDERER_OUTPUT_CHARS };
