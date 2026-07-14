/**
 * Kyrei engine v2 — shared contract types.
 *
 * These types define the boundary between the engine (TS) and the gateway
 * (JS). The event shape and MessagePart MUST stay compatible with the current
 * renderer so the UI does not change (see design.md Data Models).
 */

import type { ModelMessage } from "ai";
import type { GBrainConfig } from "./memory/gbrain.js";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface SubagentEventBasePayload {
  /** Zero for direct children; increases for bounded nested helpers. */
  depth: number;
  goal: string;
  parent_id: string | null;
  parent_tool_call_id: string;
  subagent_id: string;
  task_count: number;
  task_index: number;
  /** Team metadata is optional so legacy delegate_read frames stay compatible. */
  run_id?: string;
  task_id?: string;
  role_id?: string;
  provider_id?: string;
}

export interface SubagentEventMetadata {
  confidence?: number;
  cost_usd?: number;
  evidence?: string[];
  files_read?: string[];
  files_written?: string[];
  input_tokens?: number;
  model?: string;
  output_tokens?: number;
  total_tokens?: number;
  tool_count?: number;
  provider_calls?: number;
  provenance?: string[];
  uncertainties?: string[];
  validation?: string[];
  what_was_not_checked?: string[];
}

/** Hermes-compatible lifecycle frames for one isolated delegated child. */
export type SubagentEvent =
  | {
      type: "subagent.start";
      payload: SubagentEventBasePayload & { status: "running" };
    }
  | {
      type: "subagent.progress";
      payload: SubagentEventBasePayload & SubagentEventMetadata & { status: "running"; text: string };
    }
  | {
      type: "subagent.complete";
      payload: SubagentEventBasePayload &
        SubagentEventMetadata & {
          duration_seconds: number;
          status: "completed";
          summary: string;
        };
    }
  | {
      type: "subagent.failed";
      payload: SubagentEventBasePayload &
        SubagentEventMetadata & {
          duration_seconds: number;
          error: string;
          status: "failed" | "interrupted";
          summary: string;
        };
    };

/** Terminal reason for a turn (ACP-like stopReason, see requirements §2.3). */
export type TurnStatus = "complete" | "interrupted" | "error" | "max_steps";

/** Events emitted by the engine and relayed by the gateway over SSE. */
export type KyreiEvent =
  | SubagentEvent
  | {
      type: "team.start";
      payload: { run_id: string; profile_id: string; workflow: "supervisor" | "consensus"; task_count: number };
    }
  | {
      type: "team.complete";
      payload: {
        run_id: string;
        profile_id: string;
        status: "completed" | "failed" | "interrupted";
        completed_tasks: number;
        failed_tasks: number;
      };
    }
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
        snapshot_id?: string;
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
  | { type: "error"; payload: { code?: string; message?: string } };

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
      snapshotId?: string;
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

export interface DelegationConfig {
  /** Expose delegate_read to the parent model. */
  enabled: boolean;
  /** Maximum independent goals accepted by one delegate_read call. */
  maxTasks: number;
  /** Maximum child model calls running at once for the active parent turn. */
  maxParallel: number;
  /** Maximum model/tool loop steps available to each read-only child. */
  maxSteps: number;
}

/** User-authored behaviour profile. It is advisory and always subordinate to Kyrei policy. */
export interface PromptProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

export interface EngineConfig {
  maxSteps: number;
  commandTimeoutMs: number;
  maxToolOutput: number;
  contextBudget: { softPct: number; hardPct: number };
  permissions: PermissionConfig;
  fallbackChain: string[];
  /** Optional OS sandbox. strict-required blocks commands when enforcement is unavailable. */
  sandbox: "off" | "strict" | "strict-required";
  /** Provider API retry count on transient failures (agent.api_max_retries). */
  apiMaxRetries: number;
  /** Optional assistant personality/style prepended to the system prompt. */
  personality: string;
  /** Bounded user-authored prompt profiles available to the main agent and Team roles. */
  promptProfiles: PromptProfile[];
  /** Empty means no additional profile is assigned to the main agent. */
  activePromptProfileId: string;
  /** Max characters returned by read_file (separate from tool-output cap). */
  fileReadMaxChars: number;
  /** Flat, bounded, read-only subagent delegation. */
  delegation: DelegationConfig;
  /** Optional external knowledge adapters. Built-in project memory remains canonical. */
  memory: { gbrain: GBrainConfig };
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  maxSteps: 12,
  commandTimeoutMs: 60_000,
  maxToolOutput: 12_000,
  contextBudget: { softPct: 0.75, hardPct: 0.9 },
  permissions: { terminal: "auto", web: "read", review: "agent", rules: [] },
  fallbackChain: [],
  sandbox: "off",
  apiMaxRetries: 2,
  personality: "",
  promptProfiles: [],
  activePromptProfileId: "",
  fileReadMaxChars: 250_000,
  delegation: {
    enabled: true,
    maxTasks: 3,
    maxParallel: 3,
    maxSteps: 8,
  },
  memory: {
    gbrain: {
      mode: "off",
      command: "gbrain",
      timeoutMs: 180_000,
      maxOutputBytes: 200_000,
    },
  },
};

/** Optional per-turn model tuning (reasoning/effort). UI-driven, opt-in. */
export interface ModelParams {
  /** Reasoning effort: "minimal" | "low" | "medium" | "high" (or "off"/unset to disable). */
  effort?: string;
  /** Latency-first hint; when set without an explicit effort, implies minimal reasoning. */
  fast?: boolean;
  /** Explicit thinking toggle; when true without effort, implies medium. */
  reasoning?: boolean;
  /** User-confirmed context/input limit. Runtime validates bounds before use. */
  contextWindowOverride?: number;
  /** User-confirmed output-token limit. Runtime validates bounds before use. */
  maxOutputOverride?: number;
}

export type ProviderProtocol =
  | "openai-chat"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "amazon-bedrock"
  | "google-vertex";

/** Protocol-scoped credentials loaded only by the local gateway secret store. */
export interface ProviderCredentials {
  apiKey?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  project?: string;
  location?: string;
  clientEmail?: string;
  privateKey?: string;
}

export interface RuntimeSkill {
  id: string;
  name: string;
  description: string;
  provenance: "global" | "project" | "custom" | "kiro";
  content: string;
  /** Private runtime-only documents explicitly linked from this skill. */
  documents?: RuntimeSkillDocument[];
}

export interface RuntimeSkillDocument {
  id: string;
  label: string;
  relativePath: string;
  source: "skill" | "kiro-docs";
  /** Set for a leaf discovered from one directly linked local index. */
  parentId?: string;
}

export interface RuntimeSkillDocumentContent extends RuntimeSkillDocument {
  content: string;
}

/**
 * Provider-reported model limits carried across the private gateway boundary.
 * Fields stay optional because an honest provider catalog may not publish one
 * or both values.
 */
export interface RuntimeModelLimits {
  contextWindow?: number;
  maxOutput?: number;
}

/** Gateway-resolved private target for an isolated auxiliary model call. */
export interface RuntimeProviderTarget {
  providerId: string;
  /** Private account identity for same-provider routing; never contains credentials. */
  accountId?: string;
  protocol: ProviderProtocol;
  baseURL: string;
  model: string;
  apiKey: string;
  credentials?: ProviderCredentials;
  headers?: Record<string, string>;
  requiresApiKey?: boolean;
  /** Sanitized live/curated limits for this exact provider endpoint + model. */
  limits?: RuntimeModelLimits;
}

/** Credential-free identity exposed to gateway-owned account admission. */
export interface ProviderAttemptTarget {
  providerId: string;
  accountId?: string;
  modelId: string;
}

export type ProviderAttemptPhase = "start" | "probe" | "stream";
export type ProviderAttemptOutcomeKind =
  | "capacity-unavailable"
  | "tool-unsupported"
  | "retryable-error"
  | "terminal-error"
  | "interrupted"
  | "success";

/** Safe per-attempt telemetry. It intentionally carries no endpoint or credential fields. */
export interface ProviderAttemptOutcome extends ProviderAttemptTarget {
  outcome: ProviderAttemptOutcomeKind;
  phase: ProviderAttemptPhase;
  statusCode?: number;
  retryAfterMs?: number;
}

/**
 * Synchronous gateway-owned admission hook used immediately before each real
 * provider request. A null handle means that candidate is currently at
 * capacity. Every non-null handle is released exactly once by the engine.
 */
export interface ProviderAttemptLifecycle {
  acquire(target: ProviderAttemptTarget): unknown | null;
  release(handle: unknown, outcome: ProviderAttemptOutcome): void;
}

/** Errors thrown before a terminal result may carry the attempts completed so far. */
export interface RunKyreiChatError extends Error {
  providerAttempts?: ProviderAttemptOutcome[];
}

export type AgentCapability =
  | "workspace.read"
  | "workspace.write"
  | "terminal"
  | "web"
  | "memory.read"
  | "memory.write"
  | "skills.read"
  | "delegate";

export interface RuntimeTeamLimits {
  maxParallel: number;
  maxDepth: number;
  maxAgents: number;
  maxTasks: number;
  maxStepsPerAgent: number;
  timeoutMs: number;
}

/** Gateway-resolved role. Credentials never cross back into public config/events. */
export interface RuntimeTeamRole {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  /** Public assignment id retained for diagnostics; it contains no prompt text. */
  promptProfileId?: string;
  /** Engine-resolved profile content. Never accepted from a renderer runtime spec. */
  systemPrompt?: string;
  target: RuntimeProviderTarget;
  skillIds: string[];
  capabilities: AgentCapability[];
  canSpawn: boolean;
  maxChildren: number;
}

export interface RuntimeTeamSpec {
  profileId: string;
  name: string;
  workflow: "supervisor" | "consensus";
  limits: RuntimeTeamLimits;
  roles: RuntimeTeamRole[];
}

/**
 * Gateway-owned execution port for the acting agent's `run_command` tool.
 *
 * The tool remains the policy authority: this port is called only after
 * permission checks, pre-hooks, and sandbox command wrapping have completed.
 * Implementations must execute `command` exactly once and return its bounded
 * textual result.
 */
export interface CommandRunnerPort {
  run(input: {
    command: string;
    cwd: string;
    timeoutMs: number;
    ownerId: string;
    actorId: string;
    toolCallId: string;
    abortSignal?: AbortSignal;
    sensitiveValues?: readonly string[];
  }): Promise<string>;
}

/** Options passed to the engine entry point (v1-compatible + abortSignal). */
export interface RunKyreiChatOpts {
  emit: (event: KyreiEvent) => void;
  messages: ModelMessage[];
  providerBase: string;
  providerProtocol: ProviderProtocol;
  /** Stable provider-registry id for events and model preset separation. */
  providerId?: string;
  /** Account selected by the gateway for the primary target. */
  providerAccountId?: string;
  /** Non-secret provider headers configured locally by the user. */
  providerHeaders?: Record<string, string>;
  /** Local OpenAI-compatible servers may intentionally accept no API key. */
  requiresApiKey?: boolean;
  apiKey: string;
  /** Multi-field credentials for Bedrock/Vertex; never supplied by the renderer chat request. */
  providerCredentials?: ProviderCredentials;
  model: string;
  /** Sanitized limits for the selected primary provider target. */
  modelLimits?: RuntimeModelLimits;
  /** Optional dedicated provider/model for read-only delegated children. */
  workerProvider?: RuntimeProviderTarget;
  /** Ordered, gateway-resolved fallback targets with isolated credentials. */
  fallbackProviders?: RuntimeProviderTarget[];
  /** Optional just-in-time account capacity and health lifecycle. */
  providerAttemptLifecycle?: ProviderAttemptLifecycle;
  /** Optional multi-provider team available to the acting session model. */
  team?: RuntimeTeamSpec;
  workspace?: string;
  /** Gateway-owned local audit location; never supplied by the renderer. */
  auditLogPath?: string;
  /** Gateway-owned session correlation for local audit records. */
  sessionId?: string;
  /** Optional internal desktop adapter; never accepted from renderer input. */
  commandRunner?: CommandRunnerPort;
  abortSignal?: AbortSignal;
  config?: Partial<EngineConfig>;
  /** Reasoning/effort tuning applied to the provider request (opt-in). */
  modelParams?: ModelParams;
  /** User-enabled Agent Skills, prevalidated and bounded by the local gateway. */
  skills?: RuntimeSkill[];
  /** Gateway-owned usage recorder; never supplied by the renderer. */
  onSkillUsed?: (id: string) => void | Promise<void>;
  /** Gateway-owned lazy reader; document contents never ride in runtime config. */
  readSkillDocument?: (skillId: string, documentId: string) => Promise<RuntimeSkillDocumentContent | null>;
}

export interface RunKyreiChatResult {
  text: string;
  parts: MessagePart[];
  status: TurnStatus;
  attempts: ProviderAttemptOutcome[];
  route?: {
    providerId: string;
    modelId: string;
    accountId?: string;
  };
}

/** A single hunk of a context-anchored patch (apply engine, requirements §3). */
export interface PatchHunk {
  anchor?: string;
  context: string[];
  remove: string[];
  add: string[];
  ops: Array<{ kind: " " | "-" | "+"; text: string }>;
}
