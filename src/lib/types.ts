export type Role = "user" | "assistant" | "system";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ToolPart {
  type: "tool";
  toolCallId: string;
  name: string;
  args?: unknown;
  result?: string;
  inlineDiff?: string;
  error?: string;
  running: boolean;
  durationS?: number;
  /** Live progress text streamed while the tool runs (tool.progress). */
  progress?: string;
}

export type MessagePart = TextPart | ReasoningPart | ToolPart;

export interface ChatMessage {
  id: string;
  role: Role;
  parts: MessagePart[];
  pending?: boolean;
}

export interface SessionInfo {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Runtime turn status from the gateway (absent = idle). */
  status?: "idle" | "working";
}

export interface AppConfig {
  provider: string;
  model: string;
  workspace: string;
  hasKey: boolean;
  /** Non-secret engine tuning (permissions/roles/budgets); shown in Advanced. */
  engine?: Record<string, unknown>;
}

/** Event frames streamed from the gateway (Server-Sent Events). */
export interface GatewayEvent {
  type: string;
  payload?: {
    text?: string;
    tool_call_id?: string;
    name?: string;
    args?: unknown;
    result?: string;
    error?: string;
    duration_s?: number;
    inline_diff?: string;
    status?: string;
    session_id?: string;
    title?: string;
    message?: string;
  };
}
