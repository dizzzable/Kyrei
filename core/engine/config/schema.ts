/**
 * Engine config schema + resolution (task 2.6).
 *
 * The gateway/UI passes an untrusted partial config (permissions, provider
 * roles, fallback chain, budgets). This module validates it with Zod, fills
 * defaults, migrates older shapes, and returns a fully-typed EngineConfig.
 *
 * Design goals:
 *  - Never throw on bad input from the UI: invalid fields fall back to defaults
 *    and are reported via `warnings` (fail-open for resilience, not silence).
 *  - Deterministic: same input ⇒ same output (no clock/randomness).
 *  - Single source of truth for defaults (DEFAULT_ENGINE_CONFIG in types.ts).
 */

import { z } from "zod";
import type { EngineConfig, PermissionConfig } from "../types.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";

const TerminalPermissionSchema = z.enum(["off", "auto", "turbo"]);
const WebPermissionSchema = z.enum(["off", "search", "read"]);
const ReviewPermissionSchema = z.enum(["always", "agent", "request"]);

const PermissionRuleSchema = z.object({
  pattern: z.string().min(1),
  action: z.enum(["allow", "ask", "deny"]),
});

const PermissionConfigSchema = z.object({
  terminal: TerminalPermissionSchema.default(DEFAULT_ENGINE_CONFIG.permissions.terminal),
  web: WebPermissionSchema.default(DEFAULT_ENGINE_CONFIG.permissions.web),
  review: ReviewPermissionSchema.default(DEFAULT_ENGINE_CONFIG.permissions.review),
  rules: z.array(PermissionRuleSchema).default([]),
  protectedPaths: z.array(z.string().min(1).max(260)).max(64).default(
    DEFAULT_ENGINE_CONFIG.permissions.protectedPaths,
  ),
  protectedPathAllowOnce: z.array(z.string().min(1).max(500)).max(200).optional(),
});

const DENY_ALL_RULE: PermissionConfig["rules"][number] = { pattern: ".*", action: "deny" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isUsableRulePattern(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Permission input is normalized separately from general config recovery.
 * Missing fields keep the product defaults, but present malformed security
 * fields fail closed: terminal/web -> off, review -> always. Rules are
 * salvaged independently; an invalid action becomes deny for its valid scope,
 * while an unusable scope becomes deny-all because silently dropping a rule
 * could discard an intended denial.
 */
function normalizePermissions(value: Record<string, unknown>, warnings: string[]): void {
  if (!hasOwn(value, "permissions") || value.permissions === undefined) return;

  if (!isRecord(value.permissions)) {
    warnings.push("config.permissions: expected an object — using conservative security defaults");
    value.permissions = {
      terminal: "off",
      web: "off",
      review: "always",
      rules: [{ ...DENY_ALL_RULE }],
      protectedPaths: [...DEFAULT_ENGINE_CONFIG.permissions.protectedPaths],
    } satisfies PermissionConfig;
    return;
  }

  const permissions = { ...value.permissions };
  const normalizeEnum = <T extends string>(
    key: "terminal" | "web" | "review",
    schema: z.ZodType<T>,
    fallback: T,
  ): void => {
    if (!hasOwn(permissions, key) || permissions[key] === undefined) return;
    const parsed = schema.safeParse(permissions[key]);
    if (parsed.success) {
      permissions[key] = parsed.data;
      return;
    }
    warnings.push(`config.permissions.${key}: invalid security value — using conservative fallback '${fallback}'`);
    permissions[key] = fallback;
  };

  normalizeEnum("terminal", TerminalPermissionSchema, "off");
  normalizeEnum("web", WebPermissionSchema, "off");
  normalizeEnum("review", ReviewPermissionSchema, "always");

  if (hasOwn(permissions, "rules") && permissions.rules !== undefined) {
    if (!Array.isArray(permissions.rules)) {
      warnings.push("config.permissions.rules: expected an array — using deny-all fallback");
      permissions.rules = [{ ...DENY_ALL_RULE }];
    } else {
      permissions.rules = permissions.rules.map((rule, index) => {
        if (!isRecord(rule) || !isUsableRulePattern(rule.pattern)) {
          warnings.push(`config.permissions.rules.${index}: invalid rule pattern — using deny-all fallback`);
          return { ...DENY_ALL_RULE };
        }
        const action = PermissionRuleSchema.shape.action.safeParse(rule.action);
        if (!action.success) {
          warnings.push(`config.permissions.rules.${index}.action: invalid security value — using conservative fallback 'deny'`);
          return { pattern: rule.pattern, action: "deny" as const };
        }
        return { pattern: rule.pattern, action: action.data };
      });
    }
  }

  value.permissions = permissions;
}

const ContextBudgetSchema = z.object({
  softPct: z.number().min(0).max(1).default(DEFAULT_ENGINE_CONFIG.contextBudget.softPct),
  hardPct: z.number().min(0).max(1).default(DEFAULT_ENGINE_CONFIG.contextBudget.hardPct),
});

const GBrainConfigSchema = z.object({
  provider: z.enum(["builtin", "external-cli"]).default(DEFAULT_ENGINE_CONFIG.memory.gbrain.provider),
  mode: z.enum(["off", "read", "read-write"]).default(DEFAULT_ENGINE_CONFIG.memory.gbrain.mode),
  command: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1).max(1_024).optional(),
  ),
  source: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().regex(/^[A-Za-z0-9._-]{1,128}$/).optional(),
  ),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(DEFAULT_ENGINE_CONFIG.memory.gbrain.timeoutMs),
  maxOutputBytes: z.number().int().min(1_000).max(5_000_000).default(DEFAULT_ENGINE_CONFIG.memory.gbrain.maxOutputBytes),
});

const LtmConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.ltm.enabled),
});

const OpenVikingConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.openviking.enabled),
  baseURL: z.string().trim().url().optional(),
});

const MemoryIndexEmbedSchema = z.object({
  mode: z.enum(["lexical", "http"]).default(DEFAULT_ENGINE_CONFIG.memory.index.embed.mode),
  baseURL: z.string().trim().url().optional(),
  model: z.string().trim().min(1).max(256).optional(),
  apiKey: z.string().trim().min(1).max(4_000).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  dim: z.number().int().min(8).max(8_192).optional(),
});

const MemoryIndexConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.index.enabled),
  backend: z.enum(["sqlite", "postgres", "off"]).default(DEFAULT_ENGINE_CONFIG.memory.index.backend),
  connectionString: z.string().trim().min(1).max(4_000).optional(),
  connectionSource: z.enum(["builtin", "external"]).optional(),
  embed: MemoryIndexEmbedSchema.default(DEFAULT_ENGINE_CONFIG.memory.index.embed),
});

const SessionMirrorConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.sessionMirror.enabled),
  readSearch: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.sessionMirror.readSearch),
  enginePrimary: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.sessionMirror.enginePrimary),
});

const MemoryCuratorConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.curator.enabled),
  autoOnArchive: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.curator.autoOnArchive),
  applyMode: z.enum(["propose", "apply_safe", "apply_all"]).default(
    DEFAULT_ENGINE_CONFIG.memory.curator.applyMode,
  ),
  maxTranscriptChars: z.number().int().min(2_000).max(200_000).default(
    DEFAULT_ENGINE_CONFIG.memory.curator.maxTranscriptChars,
  ),
  useLlm: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.curator.useLlm),
  modelSource: z.enum(["worker", "session", "default"]).default(
    DEFAULT_ENGINE_CONFIG.memory.curator.modelSource,
  ),
});

const VaultConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.vault.enabled),
  paths: z.array(z.string().min(1).max(500)).max(8).default(DEFAULT_ENGINE_CONFIG.memory.vault.paths),
  maxFiles: z.number().int().min(10).max(2_000).default(DEFAULT_ENGINE_CONFIG.memory.vault.maxFiles),
  maxFileChars: z.number().int().min(1_000).max(100_000).default(DEFAULT_ENGINE_CONFIG.memory.vault.maxFileChars),
  maxDepth: z.number().int().min(1).max(12).default(DEFAULT_ENGINE_CONFIG.memory.vault.maxDepth),
});

const MemoryRecallConfigSchema = z.object({
  k: z.number().int().min(1).max(20).default(DEFAULT_ENGINE_CONFIG.memory.recall.k),
  clusterEnabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.recall.clusterEnabled),
  clusterThreshold: z.number().min(0.5).max(0.99).default(DEFAULT_ENGINE_CONFIG.memory.recall.clusterThreshold),
  mmrEnabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.recall.mmrEnabled),
  mmrLambda: z.number().min(0).max(1).default(DEFAULT_ENGINE_CONFIG.memory.recall.mmrLambda),
});

const MemoryDecayConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.decay.enabled),
  floor: z.number().min(0.001).max(0.5).default(DEFAULT_ENGINE_CONFIG.memory.decay.floor),
});

const MemoryCiteOrRefuseConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.memory.citeOrRefuse.enabled),
  minTopScore: z.number().min(0).max(100).default(DEFAULT_ENGINE_CONFIG.memory.citeOrRefuse.minTopScore),
  minHits: z.number().int().min(1).max(20).default(DEFAULT_ENGINE_CONFIG.memory.citeOrRefuse.minHits),
});

const MemoryConfigSchema = z.object({
  gbrain: GBrainConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory.gbrain),
  ltm: LtmConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory.ltm),
  openviking: OpenVikingConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory.openviking),
  index: MemoryIndexConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory.index),
  sessionMirror: SessionMirrorConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory.sessionMirror),
  curator: MemoryCuratorConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory.curator),
  vault: VaultConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory.vault),
  recall: MemoryRecallConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory.recall),
  decay: MemoryDecayConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory.decay),
  citeOrRefuse: MemoryCiteOrRefuseConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory.citeOrRefuse),
});

const PlanningConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.planning.enabled),
});

const ReviewConfigSchema = z.object({
  cleanContext: z.boolean().default(DEFAULT_ENGINE_CONFIG.review.cleanContext),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_ENGINE_CONFIG.review.timeoutMs),
});

const ToolLoopConfigSchema = z.object({
  repeatedCallThreshold: z.number().int().min(2).max(20).default(
    DEFAULT_ENGINE_CONFIG.reliability.toolLoop.repeatedCallThreshold,
  ),
  hardStopEnabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.reliability.toolLoop.hardStopEnabled),
  healAfterFailures: z.number().int().min(1).max(20).default(
    DEFAULT_ENGINE_CONFIG.reliability.toolLoop.healAfterFailures,
  ),
});

const ReliabilityConfigSchema = z.object({
  goalVerify: z.boolean().default(DEFAULT_ENGINE_CONFIG.reliability.goalVerify),
  healHandoff: z.boolean().default(DEFAULT_ENGINE_CONFIG.reliability.healHandoff),
  maxTokens: z.number().int().min(1_000).max(50_000_000).optional(),
  maxCostUsd: z.number().min(0).max(1_000_000).optional(),
  maxSubagents: z.number().int().min(1).max(64).optional(),
  toolLoop: ToolLoopConfigSchema.default(DEFAULT_ENGINE_CONFIG.reliability.toolLoop),
  longTaskPlanGate: z.boolean().default(DEFAULT_ENGINE_CONFIG.reliability.longTaskPlanGate),
  goalVerifyFromUserTurn: z.boolean().default(DEFAULT_ENGINE_CONFIG.reliability.goalVerifyFromUserTurn),
  postEditVerify: z.enum(["off", "on", "polish", "mutate"]).default(
    DEFAULT_ENGINE_CONFIG.reliability.postEditVerify,
  ),
  verifyBeforeDone: z.boolean().default(DEFAULT_ENGINE_CONFIG.reliability.verifyBeforeDone),
});

const CompressionConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.compression.enabled),
  protectLastN: z.number().int().min(1).max(200).default(DEFAULT_ENGINE_CONFIG.compression.protectLastN),
  pruneToChars: z.number().int().min(100).max(50_000).default(DEFAULT_ENGINE_CONFIG.compression.pruneToChars),
  summaryEnabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.compression.summaryEnabled),
  summaryUseLlm: z.boolean().default(DEFAULT_ENGINE_CONFIG.compression.summaryUseLlm),
  protectFirstN: z.number().int().min(0).max(50).default(DEFAULT_ENGINE_CONFIG.compression.protectFirstN),
  summaryMinMessages: z.number().int().min(4).max(500).default(
    DEFAULT_ENGINE_CONFIG.compression.summaryMinMessages,
  ),
  summaryCooldownoffMs: z.number().int().min(0).max(3_600_000).default(
    DEFAULT_ENGINE_CONFIG.compression.summaryCooldownoffMs,
  ),
  alwaysMaskToolBodies: z.boolean().default(DEFAULT_ENGINE_CONFIG.compression.alwaysMaskToolBodies),
  goalSkim: z.boolean().default(DEFAULT_ENGINE_CONFIG.compression.goalSkim),
  pinWorkingState: z.boolean().default(DEFAULT_ENGINE_CONFIG.compression.pinWorkingState),
});

const McpServerConfigSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  command: z.string().trim().min(1).max(1_024),
  args: z.array(z.string().max(512)).max(32).optional(),
  env: z.record(z.string().max(128), z.string().max(4_096)).optional(),
  cwd: z.string().trim().max(1_024).optional(),
  enabled: z.boolean().optional(),
});

const McpConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.mcp.enabled),
  servers: z.array(McpServerConfigSchema).max(16).default(DEFAULT_ENGINE_CONFIG.mcp.servers),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(DEFAULT_ENGINE_CONFIG.mcp.timeoutMs),
  maxServers: z.number().int().min(1).max(16).default(DEFAULT_ENGINE_CONFIG.mcp.maxServers),
  maxToolsPerServer: z.number().int().min(1).max(200).default(DEFAULT_ENGINE_CONFIG.mcp.maxToolsPerServer),
  maxResultChars: z.number().int().min(1_000).max(200_000).default(DEFAULT_ENGINE_CONFIG.mcp.maxResultChars),
});

const MessagingConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.messaging.enabled),
  autoRun: z.boolean().default(DEFAULT_ENGINE_CONFIG.messaging.autoRun),
  maxBodyChars: z.number().int().min(1_000).max(20_000).default(DEFAULT_ENGINE_CONFIG.messaging.maxBodyChars),
});

const SkillsCuratorConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.skills.curator.enabled),
  applyMode: z.enum(["propose", "apply_safe"]).default(DEFAULT_ENGINE_CONFIG.skills.curator.applyMode),
  staleDays: z.number().int().min(7).max(3650).default(DEFAULT_ENGINE_CONFIG.skills.curator.staleDays),
  maxProposals: z.number().int().min(1).max(200).default(DEFAULT_ENGINE_CONFIG.skills.curator.maxProposals),
  useLlm: z.boolean().default(DEFAULT_ENGINE_CONFIG.skills.curator.useLlm),
  modelSource: z.enum(["worker", "session", "default"]).default(
    DEFAULT_ENGINE_CONFIG.skills.curator.modelSource,
  ),
  maxLlmSkills: z.number().int().min(1).max(20).default(DEFAULT_ENGINE_CONFIG.skills.curator.maxLlmSkills),
  maxSkillChars: z.number().int().min(500).max(40_000).default(
    DEFAULT_ENGINE_CONFIG.skills.curator.maxSkillChars,
  ),
});

const SkillsSleepConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.skills.sleep.enabled),
  maxTrajectories: z.number().int().min(1).max(200).default(DEFAULT_ENGINE_CONFIG.skills.sleep.maxTrajectories),
  maxProposals: z.number().int().min(1).max(100).default(DEFAULT_ENGINE_CONFIG.skills.sleep.maxProposals),
  minFailureCluster: z.number().int().min(1).max(20).default(DEFAULT_ENGINE_CONFIG.skills.sleep.minFailureCluster),
});

const SkillsConfigSchema = z.object({
  curator: SkillsCuratorConfigSchema.default(DEFAULT_ENGINE_CONFIG.skills.curator),
  sleep: SkillsSleepConfigSchema.default(DEFAULT_ENGINE_CONFIG.skills.sleep),
});

const DelegationConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.delegation.enabled),
  maxTasks: z.number().int().min(1).max(8).default(DEFAULT_ENGINE_CONFIG.delegation.maxTasks),
  maxParallel: z.number().int().min(1).max(8).default(DEFAULT_ENGINE_CONFIG.delegation.maxParallel),
  maxSteps: z.number().int().min(1).max(24).default(DEFAULT_ENGINE_CONFIG.delegation.maxSteps),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(DEFAULT_ENGINE_CONFIG.delegation.timeoutMs),
});

const PromptProfileIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const SafeSingleLineSchema = (max: number, min = 0) => z.string().trim().min(min).max(max)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "control characters are not allowed");
const SafeMultilineSchema = z.string().trim().max(20_000)
  .refine((value) => !/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/.test(value), "control characters are not allowed");
const PromptProfileSchema = z.object({
  id: PromptProfileIdSchema,
  name: SafeSingleLineSchema(120, 1),
  description: SafeSingleLineSchema(1_000).default(""),
  systemPrompt: SafeMultilineSchema,
});
const PromptProfilesSchema = z.array(PromptProfileSchema).max(64).refine(
  (profiles) => new Set(profiles.map((profile) => profile.id)).size === profiles.length,
  "prompt profile ids must be unique",
);

/** Full engine config schema. All fields optional with sane defaults. */
const ExecutionModeSchema = z.enum(["autopilot", "supervised"]);

const ReasoningEffortSchema = z.string().max(32).refine(
  (value) => value === "" || ["minimal", "low", "medium", "high", "xhigh", "max", "off"].includes(value),
  "invalid reasoning effort",
);

export const EngineConfigSchema = z.object({
  maxSteps: z.number().int().min(1).max(200).default(DEFAULT_ENGINE_CONFIG.maxSteps),
  commandTimeoutMs: z.number().int().min(1000).max(3_600_000).default(DEFAULT_ENGINE_CONFIG.commandTimeoutMs),
  maxToolOutput: z.number().int().min(500).max(200_000).default(DEFAULT_ENGINE_CONFIG.maxToolOutput),
  contextBudget: ContextBudgetSchema.default(DEFAULT_ENGINE_CONFIG.contextBudget),
  compression: CompressionConfigSchema.default(DEFAULT_ENGINE_CONFIG.compression),
  permissions: PermissionConfigSchema.default(DEFAULT_ENGINE_CONFIG.permissions),
  executionMode: ExecutionModeSchema.default(DEFAULT_ENGINE_CONFIG.executionMode),
  fallbackChain: z.array(z.string()).default([]),
  sandbox: z.enum(["off", "strict", "strict-required"]).default(DEFAULT_ENGINE_CONFIG.sandbox),
  apiMaxRetries: z.number().int().min(0).max(10).default(DEFAULT_ENGINE_CONFIG.apiMaxRetries),
  personality: z.string().max(4000).default(DEFAULT_ENGINE_CONFIG.personality),
  personalityPresetId: z.string().max(64).default(DEFAULT_ENGINE_CONFIG.personalityPresetId),
  codingMode: z.preprocess(
    (value) => (value === "balanced" ? "auto" : value),
    z.enum(["auto", "plan", "build", "polish", "deepreep"]).default(DEFAULT_ENGINE_CONFIG.codingMode),
  ),
  timezone: z.string().max(80).default(DEFAULT_ENGINE_CONFIG.timezone),
  defaultReasoningEffort: ReasoningEffortSchema.default(DEFAULT_ENGINE_CONFIG.defaultReasoningEffort || ""),
  imageInputMode: z.enum(["auto", "native", "text"]).default(DEFAULT_ENGINE_CONFIG.imageInputMode),
  promptProfiles: PromptProfilesSchema.default(DEFAULT_ENGINE_CONFIG.promptProfiles),
  activePromptProfileId: z.union([PromptProfileIdSchema, z.literal("")]).default(DEFAULT_ENGINE_CONFIG.activePromptProfileId),
  fileReadMaxChars: z.number().int().min(1000).max(5_000_000).default(DEFAULT_ENGINE_CONFIG.fileReadMaxChars),
  delegation: DelegationConfigSchema.default(DEFAULT_ENGINE_CONFIG.delegation),
  memory: MemoryConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory),
  planning: PlanningConfigSchema.default(DEFAULT_ENGINE_CONFIG.planning),
  review: ReviewConfigSchema.default(DEFAULT_ENGINE_CONFIG.review),
  reliability: ReliabilityConfigSchema.default(DEFAULT_ENGINE_CONFIG.reliability),
  messaging: MessagingConfigSchema.default(DEFAULT_ENGINE_CONFIG.messaging),
  mcp: McpConfigSchema.default(DEFAULT_ENGINE_CONFIG.mcp),
  skills: SkillsConfigSchema.default(DEFAULT_ENGINE_CONFIG.skills),
  usageBudget: z.object({
    enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.usageBudget.enabled),
    window: z.enum(["day", "month"]).default(DEFAULT_ENGINE_CONFIG.usageBudget.window),
    softCostUsd: z.number().positive().max(1_000_000).nullable().default(null),
    hardCostUsd: z.number().positive().max(1_000_000).nullable().default(null),
    softTokens: z.number().int().positive().max(1e12).nullable().default(null),
    hardTokens: z.number().int().positive().max(1e12).nullable().default(null),
  }).default(DEFAULT_ENGINE_CONFIG.usageBudget),
});

export interface ResolveResult {
  config: EngineConfig;
  warnings: string[];
}

/** Legacy → current shape migrations, applied before validation. */
function migrate(raw: unknown): { value: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  if (raw == null || typeof raw !== "object") return { value: {}, warnings };
  const v = { ...(raw as Record<string, unknown>) };
  const agent = isRecord(v["agent"]) ? v["agent"] : null;
  const terminal = isRecord(v["terminal"]) ? v["terminal"] : null;
  const toolOutput = isRecord(v["tool_output"]) ? v["tool_output"] : null;
  const compression = isRecord(v["compression"]) ? v["compression"] : null;
  const toolLoop = isRecord(v["tool_loop_guardrails"]) ? v["tool_loop_guardrails"] : null;
  const display = isRecord(v["display"]) ? v["display"] : null;

  // Before Kyrei Memory became built in, this field always represented an
  // external `gbrain` executable. Preserve a custom command as an explicit
  // compatibility adapter, but turn the old implicit default into the new
  // offline provider. This migration never touches any third-party data.
  if (isRecord(v["memory"]) && isRecord(v["memory"]["gbrain"])) {
    const memory = { ...(v["memory"] as Record<string, unknown>) };
    const gbrain = { ...(memory["gbrain"] as Record<string, unknown>) };
    if (gbrain["provider"] == null) {
      const command = typeof gbrain["command"] === "string" ? gbrain["command"].trim() : "";
      if (command && command !== "gbrain") {
        gbrain["provider"] = "external-cli";
        warnings.push("migrated custom GBrain command to memory.gbrain.provider=external-cli");
      } else {
        gbrain["provider"] = "builtin";
        delete gbrain["command"];
        warnings.push("migrated default GBrain setup to built-in Kyrei Memory");
      }
      memory["gbrain"] = gbrain;
      v["memory"] = memory;
    }
  }

  // v0.1: flat `autonomy: "auto" | "turbo" | "off"` → permissions.terminal
  if (typeof v["autonomy"] === "string" && v["permissions"] == null) {
    v["permissions"] = { terminal: v["autonomy"] };
    delete v["autonomy"];
    warnings.push("migrated legacy 'autonomy' → permissions.terminal");
  }
  // v0.1: `maxToolCalls` renamed to `maxSteps`
  if (v["maxSteps"] == null && typeof v["maxToolCalls"] === "number") {
    v["maxSteps"] = v["maxToolCalls"];
    delete v["maxToolCalls"];
    warnings.push("migrated legacy 'maxToolCalls' → maxSteps");
  }
  // Hermes nested config: `agent.max_turns` → `maxSteps`
  if (v["maxSteps"] == null && agent && typeof agent["max_turns"] === "number") {
    v["maxSteps"] = agent["max_turns"];
    warnings.push("migrated Hermes 'agent.max_turns' → maxSteps");
  }
  // Hermes nested config: `agent.api_max_retries` → `apiMaxRetries`
  if (v["apiMaxRetries"] == null && agent && typeof agent["api_max_retries"] === "number") {
    v["apiMaxRetries"] = agent["api_max_retries"];
    warnings.push("migrated Hermes 'agent.api_max_retries' → apiMaxRetries");
  }
  // Hermes `agent.reasoning_effort` → `defaultReasoningEffort`
  if (
    (v["defaultReasoningEffort"] == null || v["defaultReasoningEffort"] === "")
    && agent
    && typeof agent["reasoning_effort"] === "string"
    && agent["reasoning_effort"].trim()
  ) {
    v["defaultReasoningEffort"] = String(agent["reasoning_effort"]).trim().toLowerCase();
    warnings.push("migrated Hermes 'agent.reasoning_effort' → defaultReasoningEffort");
  }
  // Hermes `agent.image_input_mode` → `imageInputMode`
  if (
    v["imageInputMode"] == null
    && agent
    && typeof agent["image_input_mode"] === "string"
  ) {
    const mode = String(agent["image_input_mode"]).trim().toLowerCase();
    if (mode === "auto" || mode === "native" || mode === "text") {
      v["imageInputMode"] = mode;
      warnings.push("migrated Hermes 'agent.image_input_mode' → imageInputMode");
    }
  }
  // Hermes snake_case top-level: `file_read_max_chars` → `fileReadMaxChars`
  if (v["fileReadMaxChars"] == null && typeof v["file_read_max_chars"] === "number") {
    v["fileReadMaxChars"] = v["file_read_max_chars"];
    delete v["file_read_max_chars"];
    warnings.push("migrated Hermes 'file_read_max_chars' → fileReadMaxChars");
  }
  // Hermes `tool_output.max_bytes` → `maxToolOutput` (cap to schema max)
  if (v["maxToolOutput"] == null && toolOutput && typeof toolOutput["max_bytes"] === "number") {
    const bytes = toolOutput["max_bytes"];
    v["maxToolOutput"] = Math.min(200_000, Math.max(500, Math.floor(bytes)));
    warnings.push("migrated Hermes 'tool_output.max_bytes' → maxToolOutput");
  }
  // Hermes `terminal.timeout` (seconds) → `commandTimeoutMs`
  if (v["commandTimeoutMs"] == null && terminal && typeof terminal["timeout"] === "number") {
    const seconds = terminal["timeout"];
    // Heuristic: values ≤ 3600 are seconds; larger values already look like ms.
    v["commandTimeoutMs"] = seconds <= 3_600 ? Math.floor(seconds * 1_000) : Math.floor(seconds);
    warnings.push("migrated Hermes 'terminal.timeout' → commandTimeoutMs");
  }
  // Hermes `display.personality` free text → personality when empty
  if (
    (v["personality"] == null || v["personality"] === "")
    && display
    && typeof display["personality"] === "string"
    && display["personality"].trim()
  ) {
    v["personality"] = display["personality"].trim().slice(0, 4_000);
    warnings.push("migrated Hermes 'display.personality' → personality");
  }
  // Normalize personalityPresetId when free text exists without an id.
  if (
    (v["personalityPresetId"] == null || v["personalityPresetId"] === "")
    && typeof v["personality"] === "string"
    && v["personality"].trim()
  ) {
    v["personalityPresetId"] = "custom";
  }
  if (v["personalityPresetId"] == null || v["personalityPresetId"] === "") {
    v["personalityPresetId"] = "none";
  }
  // Hermes top-level `timezone`
  if ((v["timezone"] == null || v["timezone"] === "") && typeof v["timezone"] !== "string") {
    /* no-op: timezone key may already be string empty */
  }
  if (
    (v["timezone"] == null || v["timezone"] === "")
    && typeof (raw as Record<string, unknown>)["timezone"] === "string"
  ) {
    // already copied via spread when present
  }
  // Hermes compression → Kyrei compression + optional softPct from free-space threshold
  if (compression) {
    const nextComp = isRecord(v["compression"]) ? { ...v["compression"] } : {};
    let cMigrated = false;
    if (nextComp["enabled"] == null && typeof compression["enabled"] === "boolean") {
      nextComp["enabled"] = compression["enabled"];
      cMigrated = true;
    }
    if (nextComp["protectLastN"] == null && typeof compression["protect_last_n"] === "number") {
      nextComp["protectLastN"] = compression["protect_last_n"];
      cMigrated = true;
    }
    if (cMigrated) {
      v["compression"] = nextComp;
      warnings.push("migrated Hermes 'compression.*' → compression");
    }
    // Hermes threshold = free-space fraction; softPct ≈ 1 - threshold
    if (
      !isRecord(v["contextBudget"])
      && typeof compression["threshold"] === "number"
      && compression["threshold"] > 0
      && compression["threshold"] < 1
    ) {
      const softPct = Math.min(0.95, Math.max(0.3, 1 - compression["threshold"]));
      const hardPct = Math.min(0.99, Math.max(softPct + 0.05, softPct + 0.1));
      v["contextBudget"] = { softPct, hardPct };
      warnings.push("migrated Hermes 'compression.threshold' → contextBudget.softPct");
    } else if (
      isRecord(v["contextBudget"])
      && (v["contextBudget"] as Record<string, unknown>)["softPct"] == null
      && typeof compression["threshold"] === "number"
      && compression["threshold"] > 0
      && compression["threshold"] < 1
    ) {
      const softPct = Math.min(0.95, Math.max(0.3, 1 - compression["threshold"]));
      v["contextBudget"] = { ...v["contextBudget"], softPct };
      warnings.push("migrated Hermes 'compression.threshold' → contextBudget.softPct");
    }
  }
  // Hermes tool_loop_guardrails → reliability.toolLoop
  if (toolLoop) {
    const reliability = isRecord(v["reliability"]) ? { ...v["reliability"] } : {};
    const existingLoop = isRecord(reliability["toolLoop"]) ? { ...reliability["toolLoop"] } : {};
    let loopMigrated = false;
    if (existingLoop["hardStopEnabled"] == null && typeof toolLoop["hard_stop_enabled"] === "boolean") {
      existingLoop["hardStopEnabled"] = toolLoop["hard_stop_enabled"];
      loopMigrated = true;
    }
    const hardAfter = isRecord(toolLoop["hard_stop_after"]) ? toolLoop["hard_stop_after"] : null;
    if (existingLoop["repeatedCallThreshold"] == null && hardAfter && typeof hardAfter["idempotent_no_progress"] === "number") {
      existingLoop["repeatedCallThreshold"] = hardAfter["idempotent_no_progress"];
      loopMigrated = true;
    }
    if (existingLoop["healAfterFailures"] == null && hardAfter && typeof hardAfter["exact_failure"] === "number") {
      existingLoop["healAfterFailures"] = hardAfter["exact_failure"];
      loopMigrated = true;
    }
    if (loopMigrated) {
      reliability["toolLoop"] = existingLoop;
      v["reliability"] = reliability;
      warnings.push("migrated Hermes 'tool_loop_guardrails.*' → reliability.toolLoop");
    }
  }
  // Early Kyrei builds exposed these aliases in Settings, but no runtime path
  // ever consumed them. Drop the cosmetic contract rather than unexpectedly
  // activating a previously inert value.
  if (hasOwn(v, "providerRoles")) {
    delete v["providerRoles"];
    warnings.push("dropped legacy 'providerRoles' aliases (they had no runtime consumers)");
  }
  // Hermes uses one concurrency knob for both accepted batch width and active
  // children. Kyrei exposes the two limits separately while preserving it.
  if (isRecord(v["delegation"])) {
    const delegation = { ...v["delegation"] };
    const legacyConcurrency = delegation["max_concurrent_children"];
    let migrated = false;
    if (typeof legacyConcurrency === "number") {
      if (delegation["maxTasks"] == null) {
        delegation["maxTasks"] = legacyConcurrency;
        migrated = true;
      }
      if (delegation["maxParallel"] == null) {
        delegation["maxParallel"] = legacyConcurrency;
        migrated = true;
      }
      delete delegation["max_concurrent_children"];
    }
    if (typeof delegation["max_iterations"] === "number" && delegation["maxSteps"] == null) {
      delegation["maxSteps"] = Math.min(24, Math.max(1, Math.floor(delegation["max_iterations"])));
      delete delegation["max_iterations"];
      migrated = true;
      warnings.push("migrated Hermes 'delegation.max_iterations' → delegation.maxSteps");
    }
    if (typeof delegation["child_timeout_seconds"] === "number" && delegation["timeoutMs"] == null) {
      delegation["timeoutMs"] = Math.min(300_000, Math.max(1_000, Math.floor(delegation["child_timeout_seconds"] * 1_000)));
      delete delegation["child_timeout_seconds"];
      migrated = true;
      warnings.push("migrated Hermes 'delegation.child_timeout_seconds' → delegation.timeoutMs");
    }
    if (migrated && !warnings.some((w) => w.includes("max_concurrent_children") || w.includes("max_iterations") || w.includes("child_timeout"))) {
      warnings.push("migrated Hermes 'delegation.max_concurrent_children' to maxTasks/maxParallel");
    } else if (migrated && typeof legacyConcurrency === "number") {
      if (!warnings.some((w) => w.includes("max_concurrent_children"))) {
        warnings.push("migrated Hermes 'delegation.max_concurrent_children' to maxTasks/maxParallel");
      }
    }
    v["delegation"] = delegation;
  }
  // Strip Hermes-only blobs so they do not fail Zod top-level open objects.
  // (resolveEngineConfig only keeps known EngineConfig keys via schema.)
  return { value: v, warnings };
}

/**
 * Validate + resolve a partial config from the UI/gateway into a full
 * EngineConfig. Invalid fields are dropped (replaced by defaults) with a
 * warning instead of throwing, so a bad setting can never brick the engine.
 */
export function resolveEngineConfig(raw?: unknown): ResolveResult {
  const { value, warnings } = migrate(raw);
  normalizePermissions(value, warnings);
  const parsed = EngineConfigSchema.safeParse(value);
  if (parsed.success) {
    const cfg = parsed.data;
    // Enforce invariant: soft budget must be below hard budget.
    if (cfg.contextBudget.softPct >= cfg.contextBudget.hardPct) {
      warnings.push("contextBudget.softPct >= hardPct — reset to defaults");
      cfg.contextBudget = { ...DEFAULT_ENGINE_CONFIG.contextBudget };
    }
    if (cfg.delegation.maxParallel > cfg.delegation.maxTasks) {
      warnings.push("delegation.maxParallel > maxTasks - clamped to maxTasks");
      cfg.delegation = { ...cfg.delegation, maxParallel: cfg.delegation.maxTasks };
    }
    if (cfg.activePromptProfileId && !cfg.promptProfiles.some((profile) => profile.id === cfg.activePromptProfileId)) {
      warnings.push("activePromptProfileId does not reference an available prompt profile - cleared");
      cfg.activePromptProfileId = "";
    }
    return { config: cfg as EngineConfig, warnings };
  }

  // Partial recovery: keep valid fields, default the invalid ones.
  for (const issue of parsed.error.issues) {
    warnings.push(`config.${issue.path.join(".") || "(root)"}: ${issue.message} — using default`);
  }
  const salvaged: Record<string, unknown> = {};
  if (value && typeof value === "object") {
    const badTop = new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")));
    for (const [k, val] of Object.entries(value)) if (!badTop.has(k)) salvaged[k] = val;
  }
  const retry = EngineConfigSchema.safeParse(salvaged);
  const config = (retry.success ? retry.data : EngineConfigSchema.parse({})) as EngineConfig;
  if (config.activePromptProfileId && !config.promptProfiles.some((profile) => profile.id === config.activePromptProfileId)) {
    config.activePromptProfileId = "";
  }
  return { config, warnings };
}
