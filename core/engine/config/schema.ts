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
import type { EngineConfig } from "../types.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";

const PermissionRuleSchema = z.object({
  pattern: z.string().min(1),
  action: z.enum(["allow", "ask", "deny"]),
});

const PermissionConfigSchema = z.object({
  terminal: z.enum(["off", "auto", "turbo"]).default(DEFAULT_ENGINE_CONFIG.permissions.terminal),
  web: z.enum(["off", "search", "read"]).default(DEFAULT_ENGINE_CONFIG.permissions.web),
  review: z.enum(["always", "agent", "request"]).default(DEFAULT_ENGINE_CONFIG.permissions.review),
  rules: z.array(PermissionRuleSchema).default([]),
});

const ContextBudgetSchema = z.object({
  softPct: z.number().min(0).max(1).default(DEFAULT_ENGINE_CONFIG.contextBudget.softPct),
  hardPct: z.number().min(0).max(1).default(DEFAULT_ENGINE_CONFIG.contextBudget.hardPct),
});

const ProviderRolesSchema = z.object({
  default: z.string().default(DEFAULT_ENGINE_CONFIG.providerRoles.default),
  small: z.string().default(DEFAULT_ENGINE_CONFIG.providerRoles.small),
  plan: z.string().default(DEFAULT_ENGINE_CONFIG.providerRoles.plan),
});

/** Full engine config schema. All fields optional with sane defaults. */
export const EngineConfigSchema = z.object({
  maxSteps: z.number().int().min(1).max(200).default(DEFAULT_ENGINE_CONFIG.maxSteps),
  commandTimeoutMs: z.number().int().min(1000).max(3_600_000).default(DEFAULT_ENGINE_CONFIG.commandTimeoutMs),
  maxToolOutput: z.number().int().min(500).max(200_000).default(DEFAULT_ENGINE_CONFIG.maxToolOutput),
  contextBudget: ContextBudgetSchema.default(DEFAULT_ENGINE_CONFIG.contextBudget),
  permissions: PermissionConfigSchema.default(DEFAULT_ENGINE_CONFIG.permissions),
  providerRoles: ProviderRolesSchema.default(DEFAULT_ENGINE_CONFIG.providerRoles),
  fallbackChain: z.array(z.string()).default([]),
  sandbox: z.enum(["off", "strict"]).default(DEFAULT_ENGINE_CONFIG.sandbox),
  apiMaxRetries: z.number().int().min(0).max(10).default(DEFAULT_ENGINE_CONFIG.apiMaxRetries),
  personality: z.string().max(4000).default(DEFAULT_ENGINE_CONFIG.personality),
  fileReadMaxChars: z.number().int().min(1000).max(5_000_000).default(DEFAULT_ENGINE_CONFIG.fileReadMaxChars),
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
  return { value: v, warnings };
}

/**
 * Validate + resolve a partial config from the UI/gateway into a full
 * EngineConfig. Invalid fields are dropped (replaced by defaults) with a
 * warning instead of throwing, so a bad setting can never brick the engine.
 */
export function resolveEngineConfig(raw?: unknown): ResolveResult {
  const { value, warnings } = migrate(raw);
  const parsed = EngineConfigSchema.safeParse(value);
  if (parsed.success) {
    const cfg = parsed.data;
    // Enforce invariant: soft budget must be below hard budget.
    if (cfg.contextBudget.softPct >= cfg.contextBudget.hardPct) {
      warnings.push("contextBudget.softPct >= hardPct — reset to defaults");
      cfg.contextBudget = { ...DEFAULT_ENGINE_CONFIG.contextBudget };
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
  return { config, warnings };
}
