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
  mode: z.enum(["off", "read", "read-write"]).default(DEFAULT_ENGINE_CONFIG.memory.gbrain.mode),
  command: z.string().trim().min(1).max(1_024).default(DEFAULT_ENGINE_CONFIG.memory.gbrain.command),
  source: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().regex(/^[A-Za-z0-9._-]{1,128}$/).optional(),
  ),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).default(DEFAULT_ENGINE_CONFIG.memory.gbrain.timeoutMs),
  maxOutputBytes: z.number().int().min(1_000).max(5_000_000).default(DEFAULT_ENGINE_CONFIG.memory.gbrain.maxOutputBytes),
});

const MemoryConfigSchema = z.object({
  gbrain: GBrainConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory.gbrain),
});

const DelegationConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_ENGINE_CONFIG.delegation.enabled),
  maxTasks: z.number().int().min(1).max(8).default(DEFAULT_ENGINE_CONFIG.delegation.maxTasks),
  maxParallel: z.number().int().min(1).max(8).default(DEFAULT_ENGINE_CONFIG.delegation.maxParallel),
  maxSteps: z.number().int().min(1).max(24).default(DEFAULT_ENGINE_CONFIG.delegation.maxSteps),
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
export const EngineConfigSchema = z.object({
  maxSteps: z.number().int().min(1).max(200).default(DEFAULT_ENGINE_CONFIG.maxSteps),
  commandTimeoutMs: z.number().int().min(1000).max(3_600_000).default(DEFAULT_ENGINE_CONFIG.commandTimeoutMs),
  maxToolOutput: z.number().int().min(500).max(200_000).default(DEFAULT_ENGINE_CONFIG.maxToolOutput),
  contextBudget: ContextBudgetSchema.default(DEFAULT_ENGINE_CONFIG.contextBudget),
  permissions: PermissionConfigSchema.default(DEFAULT_ENGINE_CONFIG.permissions),
  fallbackChain: z.array(z.string()).default([]),
  sandbox: z.enum(["off", "strict", "strict-required"]).default(DEFAULT_ENGINE_CONFIG.sandbox),
  apiMaxRetries: z.number().int().min(0).max(10).default(DEFAULT_ENGINE_CONFIG.apiMaxRetries),
  personality: z.string().max(4000).default(DEFAULT_ENGINE_CONFIG.personality),
  promptProfiles: PromptProfilesSchema.default(DEFAULT_ENGINE_CONFIG.promptProfiles),
  activePromptProfileId: z.union([PromptProfileIdSchema, z.literal("")]).default(DEFAULT_ENGINE_CONFIG.activePromptProfileId),
  fileReadMaxChars: z.number().int().min(1000).max(5_000_000).default(DEFAULT_ENGINE_CONFIG.fileReadMaxChars),
  delegation: DelegationConfigSchema.default(DEFAULT_ENGINE_CONFIG.delegation),
  memory: MemoryConfigSchema.default(DEFAULT_ENGINE_CONFIG.memory),
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
  const agent = v["agent"];

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
  if (v["maxSteps"] == null && agent && typeof agent === "object" && typeof (agent as Record<string, unknown>)["max_turns"] === "number") {
    v["maxSteps"] = (agent as Record<string, unknown>)["max_turns"];
    warnings.push("migrated Hermes 'agent.max_turns' → maxSteps");
  }
  // Hermes nested config: `agent.api_max_retries` → `apiMaxRetries`
  if (
    v["apiMaxRetries"] == null &&
    agent &&
    typeof agent === "object" &&
    typeof (agent as Record<string, unknown>)["api_max_retries"] === "number"
  ) {
    v["apiMaxRetries"] = (agent as Record<string, unknown>)["api_max_retries"];
    warnings.push("migrated Hermes 'agent.api_max_retries' → apiMaxRetries");
  }
  // Hermes snake_case top-level: `file_read_max_chars` → `fileReadMaxChars`
  if (v["fileReadMaxChars"] == null && typeof v["file_read_max_chars"] === "number") {
    v["fileReadMaxChars"] = v["file_read_max_chars"];
    delete v["file_read_max_chars"];
    warnings.push("migrated Hermes 'file_read_max_chars' → fileReadMaxChars");
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
    if (migrated) {
      warnings.push("migrated Hermes 'delegation.max_concurrent_children' to maxTasks/maxParallel");
    }
    v["delegation"] = delegation;
  }
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
