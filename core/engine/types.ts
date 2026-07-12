/**
 * Kyrei engine v2 — shared contract types.
 *
 * These types define the boundary between the engine (TS) and the gateway
 * (JS). The event shape and MessagePart MUST stay compatible with the current
 * renderer so the UI does not change (see design.md Data Models).
 */

import type { ModelMessage } from "ai";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

/** Terminal reason for a turn (ACP-like stopReason, see requirements §2.3). */
export type TurnStatus = "complete" | "interrupted" | "error" | "max_steps";

/** Events emitted by the engine and relayed by the gateway over SSE. */
export type KyreiEvent =
  | { type: "message.start" }
  | { type: "message.delta"; payload: { text: string } }
  | { type: "reasoning.delta"; payload: { text: string } }
  | { type: "tool.start"; payload: { tool_call_id: string; name: string; args: unknown } }
  | { type: "tool.progress"; payload: { tool_call_id: string; text: string } }
  | {
      type: "tool.complete";
      payload: {
        tool_call_id: string;
        name: string;
        result?: string;
        inline_diff?: string;
        error?: string;
        duration_s: number;
      };
    }
  | { type: "status.update"; payload: { model?: string; provider?: string; usage?: Usage } }
  | {
      type: "approval.request";
      payload: { approval_id: string; tool_call_id: string; name: string; args: unknown; reason: string };
    }
  | { type: "message.complete"; payload: { text: string; status: TurnStatus; usage?: Usage } }
  | { type: "error"; payload: { message: string } };

/** Structured message part for durable persistence (compatible with v1). */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool";
      toolCallId: string;
      name: string;
      args?: unknown;
      result?: string;
      inlineDiff?: string;
      error?: string;
      running: boolean;
      durationS?: number;
    };

/** Unified tool result contract: title for UI, output for model, metadata structured. */
export interface ToolResult {
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
}

/** Autonomy / permission policy (two-axis, requirements §8.2). */
export interface PermissionConfig {
  terminal: "off" | "auto" | "turbo";
  /** Internal agent-only web capability: disabled, search-only, or read public pages. */
  web: "off" | "search" | "read";
  review: "always" | "agent" | "request";
  rules: Array<{ pattern: string; action: "allow" | "ask" | "deny" }>;
}

export interface EngineConfig {
  maxSteps: number;
  commandTimeoutMs: number;
  maxToolOutput: number;
  contextBudget: { softPct: number; hardPct: number };
  permissions: PermissionConfig;
  providerRoles: Record<"default" | "small" | "plan", string>;
  fallbackChain: string[];
  /** Optional OS-sandbox for run_command. "off" (default) | "strict" (best-effort). */
  sandbox: "off" | "strict";
  /** Provider API retry count on transient failures (agent.api_max_retries). */
  apiMaxRetries: number;
  /** Optional assistant personality/style prepended to the system prompt. */
  personality: string;
  /** Max characters returned by read_file (separate from tool-output cap). */
  fileReadMaxChars: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  maxSteps: 12,
  commandTimeoutMs: 60_000,
  maxToolOutput: 12_000,
  contextBudget: { softPct: 0.75, hardPct: 0.9 },
  permissions: { terminal: "auto", web: "read", review: "agent", rules: [] },
  providerRoles: { default: "default", small: "small", plan: "plan" },
  fallbackChain: [],
  sandbox: "off",
  apiMaxRetries: 2,
  personality: "",
  fileReadMaxChars: 250_000,
};

/** Optional per-turn model tuning (reasoning/effort). UI-driven, opt-in. */
export interface ModelParams {
  /** Reasoning effort: "minimal" | "low" | "medium" | "high" (or "off"/unset to disable). */
  effort?: string;
  /** Latency-first hint; when set without an explicit effort, implies minimal reasoning. */
  fast?: boolean;
  /** Explicit thinking toggle; when true without effort, implies medium. */
  reasoning?: boolean;
}

/** Options passed to the engine entry point (v1-compatible + abortSignal). */
export interface RunKyreiChatOpts {
  emit: (event: KyreiEvent) => void;
  messages: ModelMessage[];
  providerBase: string;
  /** Stable provider-registry id for events and model preset separation. */
  providerId?: string;
  /** Non-secret provider headers configured locally by the user. */
  providerHeaders?: Record<string, string>;
  /** Local OpenAI-compatible servers may intentionally accept no API key. */
  requiresApiKey?: boolean;
  apiKey: string;
  model: string;
  workspace?: string;
  /** Gateway-owned local audit location; never supplied by the renderer. */
  auditLogPath?: string;
  abortSignal?: AbortSignal;
  config?: Partial<EngineConfig>;
  /** Reasoning/effort tuning applied to the provider request (opt-in). */
  modelParams?: ModelParams;
}

export interface RunKyreiChatResult {
  text: string;
  parts: MessagePart[];
}

/** A single hunk of a context-anchored patch (apply engine, requirements §3). */
export interface PatchHunk {
  anchor?: string;
  context: string[];
  remove: string[];
  add: string[];
  ops: Array<{ kind: " " | "-" | "+"; text: string }>;
}
