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
  /** Source receipts minted only by successful Team web_fetch calls. */
  sources?: Array<{
    id: string;
    requested_url: string;
    final_url: string;
    title: string;
    content_digest: string;
    fetched_at: string;
  }>;
  files_read?: string[];
  files_written?: string[];
  /** Child finished operationally but did not produce a trustworthy conclusion. */
  incomplete?: boolean;
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
export type TurnStatus =
  | "complete"
  | "interrupted"
  | "error"
  | "max_steps"
  | "awaiting_approval"
  /**
   * Supervised execution mode: file-modifying tools ran; user must accept or
   * reject (reject restores pre-turn snapshots) before the next turn.
   */
  | "awaiting_file_review"
  /** Goal verifier found the completion condition unmet. */
  | "goal_unsatisfied"
  /** Budget guard (tokens/cost/subagents) ended the loop. */
  | "budget_exceeded"
  /** Self-heal FSM exhausted retries; distilled handoff written for human/fresh window. */
  | "heal_handoff";

/** Kiro-style execution mode: review workflow for file mutations (not shell scope). */
export type ExecutionMode = "autopilot" | "supervised";

/** One hunk inside a file review (Kiro Supervised per-hunk). */
export interface FileReviewHunk {
  id: string;
  status: "pending" | "accepted" | "rejected";
  start: number;
  end: number;
  preview: string;
}

/** One file entry inside a supervised review (accept/reject per file or hunk). */
export interface FileReviewFile {
  path: string;
  tool: string;
  snapshotId?: string;
  /** Per-file decision; pending until user acts (or derived from hunks). */
  status: "pending" | "accepted" | "rejected";
  /** Optional unified diff preview (from tool meta). */
  diffPreview?: string;
  diffOps?: Array<{ kind: " " | "+" | "-"; text: string }>;
  hunks?: FileReviewHunk[];
}

/** Pending file-edit review after a supervised turn (Kiro Supervised analogue). */
export interface FileReviewState {
  status: "pending" | "accepted" | "rejected" | "partial";
  files: FileReviewFile[];
  snapshotIds: string[];
  resolvedAt?: string;
}

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
  | {
      type: "approval.resolved";
      payload: {
        approval_id: string;
        tool_call_id: string;
        approved: boolean;
        reason?: string;
        consumed?: boolean;
      };
    }
  | {
      type: "approval.consumed";
      payload: { approval_id: string; tool_call_id: string };
    }
  | { type: "message.complete"; payload: { text: string; status: TurnStatus; usage?: Usage } }
  | { type: "error"; payload: { code?: string; message?: string } };

/** Structured message part for durable persistence (compatible with v1). */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "approval";
      approvalId: string;
      toolCallId: string;
      name: string;
      args?: unknown;
      reason: string;
      status: "pending" | "approved" | "denied" | "expired";
      createdAt?: string;
      expiresAt?: string;
      resolvedAt?: string;
      decisionReason?: string;
      consumedAt?: string;
    }
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
      awaitingApproval?: boolean;
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
  /**
   * Kiro-style protected paths: writes always require approval (both autopilot
   * and supervised). Patterns: exact basename (`mcp.json`) or path substring
   * (`.git/`, `.vscode/`).
   */
  protectedPaths: string[];
  /**
   * Session-scoped allow-once targets (canonical paths) that already passed a
   * protected-path approval this session. Not a durable security policy.
   */
  protectedPathAllowOnce?: string[];
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
  /** Hard wall-clock limit for one read-only child, including every model/tool step. */
  timeoutMs: number;
}

/** User-authored behaviour profile. It is advisory and always subordinate to Kyrei policy. */
export interface PromptProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
}

/**
 * Hermes-style context compression:
 * Stage A — tool-output prune via CCR (reversible).
 * Stage B — structured middle-turn summary (model projection only; chat JSON SoT untouched).
 */
export interface CompressionConfig {
  /** When false, soft overflow does not prune tool outputs (hard path may still summarize if summaryEnabled). */
  enabled: boolean;
  /** Preserve the last N messages untouched while pruning older tool outputs / as tail floor. */
  protectLastN: number;
  /** Target size for a truncated tool result (chars, after markers). */
  pruneToChars: number;
  /** Stage B: inject structured middle summary into model history (not chat UI). Default true. */
  summaryEnabled: boolean;
  /** Optional LLM pass for stage B; fail-open to heuristic. Default false. */
  summaryUseLlm: boolean;
  /** Head turns (non-system) kept verbatim when summarizing middle. */
  protectFirstN: number;
  /** Skip stage B when transcript shorter than this. */
  summaryMinMessages: number;
  /** Anti-thrash cooldown after a successful summary (ms). */
  summaryCooldownoffMs: number;
  /**
   * Wave D2: always mask tool bodies older than protectLastN even without soft overflow.
   * Full bodies remain in CCR when smart compress archives them.
   */
  alwaysMaskToolBodies: boolean;
  /** Wave D1: goal/focus-aware skim when compressing code/text tool output. */
  goalSkim: boolean;
  /** Wave D2: re-pin goal/open threads at the end of model history each prepareStep. */
  pinWorkingState: boolean;
}

/**
 * Hermes-style tool-loop guardrails (repeated identical calls + heal handoff).
 * Maps to Hermes `tool_loop_guardrails.*`.
 */
export interface ToolLoopConfig {
  /** Stop when the last N tool signatures are identical (idempotent no-progress). */
  repeatedCallThreshold: number;
  /** When false, skip the repeated-call hard stop (heal handoff may still run). */
  hardStopEnabled: boolean;
  /** Consecutive hard tool-errors before heal_handoff (self-heal FSM length). */
  healAfterFailures: number;
}

export interface EngineConfig {
  maxSteps: number;
  commandTimeoutMs: number;
  maxToolOutput: number;
  contextBudget: { softPct: number; hardPct: number };
  /** Soft-budget tool-output prune (Hermes compression analogue). */
  compression: CompressionConfig;
  permissions: PermissionConfig;
  /**
   * Kiro-style execution mode.
   * - autopilot: file writes apply immediately (default; review/revert after).
   * - supervised: after a turn that edited files, pause for accept/reject.
   * Shell trusted-policy remains permissions.terminal / rules (separate axis).
   */
  executionMode: ExecutionMode;
  fallbackChain: string[];
  /** Optional OS sandbox. strict-required blocks commands when enforcement is unavailable. */
  sandbox: "off" | "strict" | "strict-required";
  /** Provider API retry count on transient failures (agent.api_max_retries). */
  apiMaxRetries: number;
  /** Optional assistant personality/style prepended to the system prompt. */
  personality: string;
  /**
   * Built-in personality catalog id (`none` | preset id | `custom`).
   * Effective text is resolved via `resolvePersonalityText` (preset body or free text).
   */
  personalityPresetId: string;
  /**
   * Coding workflow mode (prompt contract; optional per-mode modelAssignments).
   * - auto: agent picks effective phase each turn
   * - plan: non-mutating planning
   * - build: implement / greenfield
   * - polish: audit / bug-hunt
   * - deepreep: deep research (code+web) + human/team orchestration
   */
  codingMode: "auto" | "plan" | "build" | "polish" | "deepreep";
  /**
   * IANA timezone (e.g. `Europe/Moscow`) injected into the system prompt so
   * the model can reason about local times. Empty = omit.
   */
  timezone: string;
  /**
   * Default reasoning effort for turns that do not pass modelParams.effort
   * (Hermes `agent.reasoning_effort`). Empty = no default.
   */
  defaultReasoningEffort: string;
  /**
   * How user-attached images are presented to the model
   * (Hermes `agent.image_input_mode`):
   * - auto: native when model reports vision, else text labels
   * - native: always multimodal image parts
   * - text: never send pixels (labels/paths only)
   */
  imageInputMode: "auto" | "native" | "text";
  /** Bounded user-authored prompt profiles available to the main agent and Team roles. */
  promptProfiles: PromptProfile[];
  /** Empty means no additional profile is assigned to the main agent. */
  activePromptProfileId: string;
  /** Max characters returned by read_file (separate from tool-output cap). */
  fileReadMaxChars: number;
  /** Flat, bounded, read-only subagent delegation. */
  delegation: DelegationConfig;
  /** Optional external knowledge adapters. Built-in project memory remains canonical. */
  memory: { 
    gbrain: GBrainConfig;
    /** Long-term memory bridge: append events/checkpoints to ltm/store/*.jsonl */
    ltm: { enabled: boolean };
    /** OpenViking local service adapter (optional AGPLv3 server, user-managed) */
    openviking: { enabled: boolean; baseURL?: string };
    /**
     * Rebuildable FTS/index projection of Tier A files.
     * Default sqlite under `.kyrei/index/`. Postgres optional for team share.
     * Never replaces plan/LTM/graph file SoT.
     */
    index: {
      enabled: boolean;
      backend: "sqlite" | "postgres" | "off";
      /** Required when backend is postgres (team multi-host FTS). */
      connectionString?: string;
      /** Identifies the loopback PGlite connection managed by Kyrei. */
      connectionSource?: "builtin" | "external";
      /**
       * Embedding path for vector projection. Default lexical (offline).
       * `http` uses an OpenAI-compatible /v1/embeddings endpoint.
       */
      embed: {
        mode: "lexical" | "http";
        baseURL?: string;
        model?: string;
        /** Optional; prefer env/secrets in production. */
        apiKey?: string;
        timeoutMs?: number;
        dim?: number;
      };
    };
    /**
     * Dual-write gateway chat → engine SessionStore (SQLite under userData).
     * JSON chat remains SoT; mirror is FTS/migration readiness + optional read path.
     */
    sessionMirror: {
      /** Write path: mirror messages after successful turns. */
      enabled: boolean;
      /**
       * Read path: use mirror SessionStore FTS inside memory_search when
       * sessionMirrorDir is provided by the gateway. JSON remains UI SoT.
       */
      readSearch: boolean;
      /**
       * A4b+A4c: public GET prefers engine when caught up; mutations dual-commit
       * JSON→engine (strict fail on mirror write). Approval/rewind algorithms
       * still execute on the JSON store first, then write-through.
       */
      enginePrimary: boolean;
    };
    /**
     * Session → durable memory curator (archive / on-demand).
     * Small bounded distill into notes / MEMORY / LTM / handoff catalogs.
     */
    curator: {
      enabled: boolean;
      /** Run curator after soft-archive (fail-open background). Recommended: true. */
      autoOnArchive: boolean;
      /** propose | apply_safe (notes+LTM+handoff) | apply_all (+MEMORY.md append). Recommended: apply_safe. */
      applyMode: "propose" | "apply_safe" | "apply_all";
      maxTranscriptChars: number;
      /** Use a one-shot LLM pass when a model is available; else heuristic only. */
      useLlm: boolean;
      /**
       * Model for LLM pass: worker (Settings worker/small assignment, recommended),
       * session (chat model), or default (active app model).
       */
      modelSource: "worker" | "session" | "default";
    };
    /**
     * Wave C3: optional external markdown vault roots (Tolaria-adjacent).
     * Opt-in absolute directories indexed into memory_search; never system policy.
     */
    vault: {
      enabled: boolean;
      paths: string[];
      maxFiles: number;
      maxFileChars: number;
      maxDepth: number;
    };
    /**
     * Wave H (MemoHood patterns): post-recall diversity for memory_search.
     * Near-dupe collapse + MMR; pure local, no network.
     */
    recall: {
      k: number;
      clusterEnabled: boolean;
      clusterThreshold: number;
      mmrEnabled: boolean;
      mmrLambda: number;
    };
    /**
     * Wave H: Ebbinghaus-style ranking decay for LTM decisions (pinned exempt).
     * Ledger rows are never deleted; low confidence only drops from snapshot.
     */
    decay: {
      enabled: boolean;
      floor: number;
    };
    /**
     * Wave H (MemoBase patterns): optional grounded refuse when memory_search
     * hits are too weak. Off by default — search still returns candidates.
     */
    citeOrRefuse: {
      enabled: boolean;
      minTopScore: number;
      minHits: number;
    };
  };
  /** Plan-as-files support (.kyrei/plan/ROADMAP.md, STATE.json, phase-N.md) */
  planning: { enabled: boolean };
  /**
   * Clean-context code review (fresh LLM sees only the diff, no conversation
   * history). Uses the same model as delegation's worker role when configured,
   * otherwise falls back to the primary session model. Never a separate
   * provider target — the engine has no credential-bearing config field.
   */
  review: { cleanContext: boolean; timeoutMs: number };
  /**
   * Phase-4 reliability guardrails. Budget limits layer on top of maxSteps;
   * goalVerify runs an optional post-turn judge when RunKyreiChatOpts.goal is set.
   */
  reliability: {
    goalVerify: boolean;
    /**
     * Stop the tool loop after consecutive hard tool failures (self-heal FSM)
     * and write a distilled handoff for human / clean-window resume.
     */
    healHandoff: boolean;
    maxTokens?: number;
    maxCostUsd?: number;
    maxSubagents?: number;
    /** Hermes tool_loop_guardrails (repeated call + heal thresholds). */
    toolLoop: ToolLoopConfig;
    /**
     * Wave D3: when codingMode is auto and the user goal looks long-horizon,
     * force plan-mode tools until a plan artifact exists or the user authorizes build.
     */
    longTaskPlanGate: boolean;
    /**
     * Wave D3: when no explicit goal is passed, verify against the last user turn
     * for polish mode or final-audit markers.
     */
    goalVerifyFromUserTurn: boolean;
    /**
     * Wave E2 / G1.1: run a light typecheck/lint after successful edit_file/write_file.
     * - off: never
     * - polish: only polish mode
     * - mutate: build / polish / deepreep / auto (default; pairs with verify-before-done)
     * - on: always (fail-open, append evidence)
     */
    postEditVerify: "off" | "on" | "polish" | "mutate";
    /**
     * Wave G1: if the turn mutated files and status would be complete without
     * diagnostics/tests/post-edit evidence, mark goal_unsatisfied instead.
     */
    verifyBeforeDone: boolean;
  };
  /**
   * Optional MCP client (stdio servers). Off by default — user must enable
   * and allowlist servers. Tools are untrusted external capabilities.
   */
  mcp: {
    enabled: boolean;
    servers: Array<{
      id: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      enabled?: boolean;
    }>;
    timeoutMs: number;
    maxServers: number;
    maxToolsPerServer: number;
    maxResultChars: number;
  };
  /**
   * Opt-in inbound messaging webhook (gateway). No Slack/Telegram SDK —
   * generic HTTP ingress that can create/append sessions. Token lives in secrets.
   */
  messaging: {
    enabled: boolean;
    /** When true, inbound text also starts an agent turn (async). */
    autoRun: boolean;
    maxBodyChars: number;
  };
  /**
   * Optional Skills catalog curator (Hermes Skill Curator analogue).
   * Default OFF. Proposal-first; never rewrites SKILL.md or deletes skills.
   */
  skills: {
    curator: {
      /** Master switch — default false (opt-in). */
      enabled: boolean;
      /** propose = review JSON only; apply_safe = auto-disable stale skills only. */
      applyMode: "propose" | "apply_safe";
      /** Days without use before a skill is considered stale. */
      staleDays: number;
      /** Cap proposals per scan. */
      maxProposals: number;
      /**
       * Optional second layer: LLM suggest_patch proposals (description / SKILL.md draft).
       * Never auto-applied — explicit apply-one only. Default false.
       */
      useLlm: boolean;
      /** Prefer worker (small), else session model, else app default. */
      modelSource: "worker" | "session" | "default";
      /** Max owned skills sent to the LLM per scan. */
      maxLlmSkills: number;
      /** Clip each skill body before the LLM call. */
      maxSkillChars: number;
    };
    /**
     * Wave C1: skill sleep from trajectories (proposal-only).
     * Manual API always works when enabled; never auto-applies SKILL.md.
     */
    sleep: {
      enabled: boolean;
      maxTrajectories: number;
      maxProposals: number;
      minFailureCluster: number;
    };
  };
  /**
   * Soft/hard spend caps evaluated against the durable usage ledger (gateway).
   * Soft → warn; hard → block new turns until the window resets.
   */
  usageBudget: {
    enabled: boolean;
    window: "day" | "month";
    softCostUsd: number | null;
    hardCostUsd: number | null;
    softTokens: number | null;
    hardTokens: number | null;
  };
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  maxSteps: 12,
  commandTimeoutMs: 60_000,
  maxToolOutput: 12_000,
  contextBudget: { softPct: 0.75, hardPct: 0.9 },
  compression: {
    enabled: true,
    protectLastN: 6,
    pruneToChars: 500,
    summaryEnabled: true,
    summaryUseLlm: false,
    protectFirstN: 2,
    summaryMinMessages: 12,
    summaryCooldownoffMs: 60_000,
    alwaysMaskToolBodies: true,
    goalSkim: true,
    pinWorkingState: true,
  },
  permissions: {
    terminal: "auto",
    web: "read",
    review: "agent",
    rules: [],
    protectedPaths: [
      ".git/",
      ".git",
      ".vscode/",
      "mcp.json",
      ".kyrei/secrets",
      "kyrei-secrets.json",
    ],
  },
  executionMode: "autopilot",
  fallbackChain: [],
  sandbox: "off",
  apiMaxRetries: 2,
  personality: "",
  personalityPresetId: "none",
  codingMode: "auto",
  timezone: "",
  defaultReasoningEffort: "",
  imageInputMode: "auto",
  promptProfiles: [],
  activePromptProfileId: "",
  fileReadMaxChars: 250_000,
  delegation: {
    enabled: true,
    maxTasks: 3,
    maxParallel: 3,
    maxSteps: 8,
    timeoutMs: 90_000,
  },
  memory: {
    gbrain: {
      provider: "builtin",
      mode: "off",
      timeoutMs: 180_000,
      maxOutputBytes: 200_000,
    },
    /** Local durable ledger under workspace/ltm — on by default (no Docker). */
    ltm: { enabled: true },
    openviking: { enabled: false },
    /** Local SQLite FTS projection; files remain SoT. */
    index: {
      enabled: true,
      backend: "sqlite",
      embed: { mode: "lexical" },
    },
    /** Dual-write chat into engine SessionStore for FTS/migration. */
    sessionMirror: { enabled: true, readSearch: true, enginePrimary: true },
    curator: {
      enabled: true,
      autoOnArchive: true,
      applyMode: "apply_safe",
      maxTranscriptChars: 24_000,
      useLlm: true,
      modelSource: "worker",
    },
    vault: {
      enabled: false,
      paths: [],
      maxFiles: 200,
      maxFileChars: 12_000,
      maxDepth: 6,
    },
    recall: {
      k: 8,
      clusterEnabled: true,
      clusterThreshold: 0.86,
      mmrEnabled: true,
      mmrLambda: 0.72,
    },
    decay: {
      enabled: true,
      floor: 0.05,
    },
    citeOrRefuse: {
      enabled: false,
      minTopScore: 4,
      minHits: 1,
    },
  },
  /** Local plan-as-files under .kyrei/plan — on by default (no external deps). */
  planning: { enabled: true },
  review: { cleanContext: false, timeoutMs: 30_000 },
  reliability: {
    goalVerify: true,
    healHandoff: true,
    toolLoop: {
      repeatedCallThreshold: 3,
      hardStopEnabled: true,
      healAfterFailures: 3,
    },
    longTaskPlanGate: true,
    goalVerifyFromUserTurn: true,
    postEditVerify: "mutate",
    verifyBeforeDone: true,
  },
  messaging: {
    enabled: false,
    autoRun: false,
    maxBodyChars: 8_000,
  },
  mcp: {
    enabled: false,
    servers: [],
    timeoutMs: 30_000,
    maxServers: 8,
    maxToolsPerServer: 64,
    maxResultChars: 24_000,
  },
  skills: {
    curator: {
      enabled: false,
      applyMode: "propose",
      staleDays: 90,
      maxProposals: 40,
      useLlm: false,
      modelSource: "worker",
      maxLlmSkills: 6,
      maxSkillChars: 6_000,
    },
    sleep: {
      enabled: true,
      maxTrajectories: 40,
      maxProposals: 24,
      minFailureCluster: 2,
    },
  },
  usageBudget: {
    enabled: false,
    window: "day",
    softCostUsd: null,
    hardCostUsd: null,
    softTokens: null,
    hardTokens: null,
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

/**
 * Account-pool failure class (no secrets / bodies). Used so flaky network and
 * soft 403 never permanently park a seat the way a real 401 ban would.
 */
export type ProviderFailureClass =
  | "network"
  | "rate_limit"
  | "server"
  | "auth_definite"
  | "auth_soft"
  | "client"
  | "unknown";

/** Safe per-attempt telemetry. It intentionally carries no endpoint or credential fields. */
export interface ProviderAttemptOutcome extends ProviderAttemptTarget {
  outcome: ProviderAttemptOutcomeKind;
  phase: ProviderAttemptPhase;
  statusCode?: number;
  retryAfterMs?: number;
  /** Classification for anti-false-ban cooldowns (never a raw error message). */
  failureClass?: ProviderFailureClass;
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
  /**
   * Subscription shield: pacing + soft TLS/header hygiene for expensive seats.
   * Gateway-owned; never accepted raw from the renderer chat payload.
   */
  subscriptionShield?: {
    enabled?: boolean;
    mode?: "off" | "standard" | "stealth";
    minIntervalMs?: number;
    connectTimeoutMs?: number;
    maxConnectionsPerOrigin?: number;
  };
  /** Optional multi-provider team available to the acting session model. */
  team?: RuntimeTeamSpec;
  workspace?: string;
  /**
   * Optional completion condition for the goal verifier. When set (and
   * reliability.goalVerify is on), a cheap post-turn judge checks whether the
   * transcript satisfies the goal before the run is treated as fully done.
   */
  goal?: string;
  /**
   * User-global memory directory (…/kyrei/memory) for GLOBAL.md layer.
   * Gateway-owned path under userData; never accepted from the renderer payload.
   */
  globalMemoryDir?: string;
  /**
   * Directory of the engine SessionStore dual-write mirror (…/session-mirror).
   * Gateway-owned; enables optional FTS read path without migrating UI chat SoT.
   */
  sessionMirrorDir?: string;
  /** Gateway-owned local audit location; never supplied by the renderer. */
  auditLogPath?: string;
  /** Gateway-owned session correlation for local audit records. */
  sessionId?: string;
  /** Gateway-owned HMAC key for native one-shot tool approval signatures. */
  approvalSecret?: string;
  /** Durable gateway barrier that must complete before an approved effect starts. */
  onApprovalConsumed?: (approvalId: string, toolCallId: string) => void | Promise<void>;
  /** Optional internal desktop adapter; never accepted from renderer input. */
  commandRunner?: CommandRunnerPort;
  abortSignal?: AbortSignal;
  config?: Partial<EngineConfig>;
  /** Reasoning/effort tuning applied to the provider request (opt-in). */
  modelParams?: ModelParams;
  /** User-enabled Agent Skills, prevalidated and bounded by the local gateway. */
  skills?: RuntimeSkill[];
  /** Skills explicitly selected for this user turn. They must be read before relevant task work. */
  requiredSkillIds?: string[];
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
  /** Private structured history required to resume signed tool approvals. */
  responseMessages?: ModelMessage[];
  route?: {
    providerId: string;
    modelId: string;
    accountId?: string;
  };
  /** Aggregated provider usage for this turn (for durable ledger / budgets). */
  usage?: Usage;
  /** Present when goal verification ran. */
  goalVerify?: {
    satisfied: boolean;
    gap?: string;
    /** Judge infrastructure failed; no semantic completion verdict was applied. */
    unavailable?: boolean;
  };
  /** Path to distilled handoff when self-heal FSM stopped the turn. */
  healHandoffPath?: string;
  /** Present when supervised mode requires accept/reject of file edits. */
  fileReview?: FileReviewState;
  /** Wave D/E harness efficiency snapshot (no secrets). */
  harness?: import("./observability/harness-metrics.js").HarnessMetricsSnapshot;
}

/** A single hunk of a context-anchored patch (apply engine, requirements §3). */
export interface PatchHunk {
  anchor?: string;
  context: string[];
  remove: string[];
  add: string[];
  ops: Array<{ kind: " " | "-" | "+"; text: string }>;
}
