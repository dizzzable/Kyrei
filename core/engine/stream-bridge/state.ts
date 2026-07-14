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
  };
}

export function pushText(st: BridgeState, delta: string): void {
  st.text += delta;
  const last = st.parts[st.parts.length - 1];
  if (last && last.type === "text") last.text += delta;
  else st.parts.push({ type: "text", text: delta });
}

export function pushReasoning(st: BridgeState, delta: string): void {
  const last = st.parts[st.parts.length - 1];
  if (last && last.type === "reasoning") last.text += delta;
  else st.parts.push({ type: "reasoning", text: delta });
}
