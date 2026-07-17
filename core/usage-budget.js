/**
 * Usage budgets (P1 governance) evaluated against the durable usage ledger.
 *
 * Config lives under `engine.usageBudget` (gateway public config). Evaluation is
 * pure so tests do not need the filesystem. Soft limits warn; hard limits block.
 *
 * Future P2: same evaluator with `accessTokenId` filter for employee keys.
 */

/** @typedef {"day"|"month"} UsageBudgetWindow */
/** @typedef {"ok"|"soft"|"hard"} UsageBudgetLevel */

/**
 * @typedef {object} UsageBudgetConfig
 * @property {boolean} enabled
 * @property {UsageBudgetWindow} window
 * @property {number|null} softCostUsd  null = off
 * @property {number|null} hardCostUsd
 * @property {number|null} softTokens
 * @property {number|null} hardTokens
 */

/**
 * @typedef {object} UsageBudgetSnapshot
 * @property {UsageBudgetConfig} config
 * @property {UsageBudgetLevel} level
 * @property {boolean} blocked
 * @property {string[]} warnings  human codes, not secrets
 * @property {string[]} hardReasons
 * @property {{ totalTokens: number, costUsd: number, requestCount: number, sinceMs: number, window: UsageBudgetWindow }} usage
 * @property {{ softCostUsd: number|null, hardCostUsd: number|null, softTokens: number|null, hardTokens: number|null }} remaining
 */

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  window: /** @type {UsageBudgetWindow} */ ("day"),
  softCostUsd: null,
  hardCostUsd: null,
  softTokens: null,
  hardTokens: null,
});

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveOrNull(value, max) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, n);
}

/**
 * Normalize budget config from engine or API body.
 * @param {unknown} raw
 * @returns {UsageBudgetConfig}
 */
export function normalizeUsageBudgetConfig(raw) {
  const source = object(raw);
  const window = source.window === "month" ? "month" : "day";
  return {
    enabled: source.enabled === true,
    window,
    softCostUsd: positiveOrNull(source.softCostUsd, 1_000_000),
    hardCostUsd: positiveOrNull(source.hardCostUsd, 1_000_000),
    softTokens: positiveOrNull(source.softTokens, 1e12) !== null
      ? Math.floor(/** @type {number} */ (positiveOrNull(source.softTokens, 1e12)))
      : null,
    hardTokens: positiveOrNull(source.hardTokens, 1e12) !== null
      ? Math.floor(/** @type {number} */ (positiveOrNull(source.hardTokens, 1e12)))
      : null,
  };
}

/** Start of UTC day/month for the budget window. */
export function budgetWindowStartMs(window, nowMs = Date.now()) {
  const d = new Date(nowMs);
  if (window === "month") {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0);
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
}

/**
 * @param {UsageBudgetConfig} config
 * @param {{ totalTokens?: number, costUsd?: number, requestCount?: number }} usage
 * @param {{ nowMs?: number }} [opts]
 * @returns {UsageBudgetSnapshot}
 */
export function evaluateUsageBudget(config, usage, opts = {}) {
  const cfg = normalizeUsageBudgetConfig(config);
  const nowMs = Number.isFinite(opts.nowMs) ? /** @type {number} */ (opts.nowMs) : Date.now();
  const sinceMs = budgetWindowStartMs(cfg.window, nowMs);
  const totalTokens = Math.max(0, Number(usage.totalTokens) || 0);
  const costUsd = Math.max(0, Number(usage.costUsd) || 0);
  const requestCount = Math.max(0, Number(usage.requestCount) || 0);

  /** @type {string[]} */
  const warnings = [];
  /** @type {string[]} */
  const hardReasons = [];

  if (cfg.enabled) {
    if (cfg.softTokens != null && totalTokens >= cfg.softTokens) {
      warnings.push("soft_tokens_reached");
    }
    if (cfg.softCostUsd != null && costUsd >= cfg.softCostUsd) {
      warnings.push("soft_cost_reached");
    }
    if (cfg.hardTokens != null && totalTokens >= cfg.hardTokens) {
      hardReasons.push("hard_tokens_exceeded");
    }
    if (cfg.hardCostUsd != null && costUsd >= cfg.hardCostUsd) {
      hardReasons.push("hard_cost_exceeded");
    }
  }

  const remaining = (limit, used) => {
    if (limit == null) return null;
    return Math.max(0, Math.round((limit - used) * 1e8) / 1e8);
  };

  const level = hardReasons.length
    ? /** @type {UsageBudgetLevel} */ ("hard")
    : warnings.length
      ? /** @type {UsageBudgetLevel} */ ("soft")
      : /** @type {UsageBudgetLevel} */ ("ok");

  return {
    config: cfg,
    level,
    blocked: cfg.enabled && hardReasons.length > 0,
    warnings,
    hardReasons,
    usage: {
      totalTokens,
      costUsd: Math.round(costUsd * 1e8) / 1e8,
      requestCount,
      sinceMs,
      window: cfg.window,
    },
    remaining: {
      softCostUsd: remaining(cfg.softCostUsd, costUsd),
      hardCostUsd: remaining(cfg.hardCostUsd, costUsd),
      softTokens: cfg.softTokens != null ? Math.max(0, cfg.softTokens - totalTokens) : null,
      hardTokens: cfg.hardTokens != null ? Math.max(0, cfg.hardTokens - totalTokens) : null,
    },
  };
}

/**
 * Read budget config from gateway engine object.
 * @param {unknown} engine
 */
export function usageBudgetFromEngine(engine) {
  const source = object(engine);
  return normalizeUsageBudgetConfig(source.usageBudget);
}

/**
 * Merge budget patch into engine object (immutable).
 * @param {Record<string, unknown>|undefined} engine
 * @param {unknown} budgetPatch
 */
export function withUsageBudget(engine, budgetPatch) {
  const base = object(engine);
  return {
    ...base,
    usageBudget: normalizeUsageBudgetConfig({
      ...object(base.usageBudget),
      ...object(budgetPatch),
    }),
  };
}

export const DEFAULT_USAGE_BUDGET = DEFAULT_CONFIG;
