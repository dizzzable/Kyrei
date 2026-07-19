/**
 * Public-only configuration for Kyrei-managed official ChatGPT profiles.
 *
 * OAuth material is intentionally absent: every account is authenticated by
 * the official Codex runtime inside its own CODEX_HOME.  This file is safe to
 * serialize to the renderer and safe to include in normal configuration.
 */

import { PROVIDER_ACCOUNT_POOL_STRATEGIES } from "./provider-account-pool.js";

export const CODEX_CHATGPT_POOL_PROVIDER_ID = "openai-codex-chatgpt";
export const MAX_CODEX_CHATGPT_POOL_ACCOUNTS = 64;

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/;
const PLAN = /^[A-Za-z0-9._-]{1,80}$/;
const STATUSES = new Set(["ready", "auth-required", "cooldown", "disabled"]);

export class CodexChatgptPoolConfigError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "CodexChatgptPoolConfigError";
    this.code = code;
  }
}

function error(code) {
  return new CodexChatgptPoolConfigError(code);
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function id(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ID.test(normalized)) throw error("codex_chatgpt_pool_account_id_invalid");
  return normalized;
}

function name(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw error("codex_chatgpt_pool_account_name_invalid");
  }
  return normalized;
}

function integer(value, fallback, min, max, code) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw error(code);
  return value;
}

function models(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 2_000) throw error("codex_chatgpt_pool_models_invalid");
  const seen = new Set();
  const next = [];
  for (const row of value) {
    if (typeof row !== "string" || !MODEL_ID.test(row) || seen.has(row)) {
      throw error("codex_chatgpt_pool_models_invalid");
    }
    seen.add(row);
    next.push(row);
  }
  return next;
}

function status(value, enabled) {
  if (!enabled) return "disabled";
  return STATUSES.has(value) && value !== "disabled" ? value : "auth-required";
}

function plan(value) {
  return typeof value === "string" && PLAN.test(value) ? value : null;
}

function timestamp(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function isCodexChatgptPoolProvider(provider) {
  return provider?.id === CODEX_CHATGPT_POOL_PROVIDER_ID && provider?.protocol === "codex-app-server";
}

export function normalizeCodexChatgptPoolAccount(value, { fallbackId, existing } = {}) {
  const source = record(value);
  const accountId = source.id === undefined && fallbackId ? id(fallbackId) : id(source.id);
  const enabled = source.enabled !== false;
  const normalized = {
    id: accountId,
    name: name(source.name ?? existing?.name),
    enabled,
    weight: integer(source.weight, existing?.weight ?? 1, 1, 100, "codex_chatgpt_pool_account_limits_invalid"),
    priority: integer(source.priority, existing?.priority ?? 100, 0, 10_000, "codex_chatgpt_pool_account_limits_invalid"),
    // Each official profile gets one app-server turn at a time.  This removes
    // a source of cross-thread state corruption while the router still pools
    // many profiles in parallel.
    maxConcurrency: 1,
    status: status(source.status ?? existing?.status, enabled),
    ...(models(source.modelIds ?? existing?.modelIds) !== undefined ? { modelIds: models(source.modelIds ?? existing?.modelIds) } : {}),
    ...(plan(source.planType ?? existing?.planType) ? { planType: plan(source.planType ?? existing?.planType) } : {}),
    ...(timestamp(source.lastVerifiedAt ?? existing?.lastVerifiedAt) ? { lastVerifiedAt: timestamp(source.lastVerifiedAt ?? existing?.lastVerifiedAt) } : {}),
  };
  return normalized;
}

export function normalizeCodexChatgptPool(value) {
  const source = record(value);
  const rows = Array.isArray(source.accounts) ? source.accounts : [];
  const seen = new Set();
  const accounts = [];
  for (const row of rows) {
    if (accounts.length >= MAX_CODEX_CHATGPT_POOL_ACCOUNTS) break;
    try {
      const account = normalizeCodexChatgptPoolAccount(row);
      if (seen.has(account.id)) continue;
      seen.add(account.id);
      accounts.push(account);
    } catch {
      // Normalization is migration-safe: malformed hand-edited rows never
      // become a path component or a runnable account.
    }
  }
  return {
    version: 1,
    // Compatibility only for the pre-pool one-account connector.  New
    // managed-pool installs never enable it implicitly.
    personalConnectorEnabled: source.personalConnectorEnabled === true,
    enabled: source.enabled === true,
    strategy: PROVIDER_ACCOUNT_POOL_STRATEGIES.includes(source.strategy) ? source.strategy : "balanced",
    sessionAffinity: source.sessionAffinity !== false,
    accounts,
  };
}

export function validateCodexChatgptPoolInput(value, current) {
  const source = record(value);
  for (const key of Object.keys(source)) {
    if (!new Set(["enabled", "strategy", "sessionAffinity"]).has(key)) {
      throw error("codex_chatgpt_pool_input_invalid");
    }
  }
  if (source.strategy !== undefined && !PROVIDER_ACCOUNT_POOL_STRATEGIES.includes(source.strategy)) {
    throw error("codex_chatgpt_pool_strategy_invalid");
  }
  const normalized = normalizeCodexChatgptPool(current);
  return {
    ...normalized,
    ...(source.enabled !== undefined ? { enabled: source.enabled === true } : {}),
    ...(source.strategy !== undefined ? { strategy: source.strategy } : {}),
    ...(source.sessionAffinity !== undefined ? { sessionAffinity: source.sessionAffinity !== false } : {}),
  };
}

export function validateNewCodexChatgptPoolAccount(value, current) {
  const source = record(value);
  for (const key of Object.keys(source)) {
    if (!new Set(["id", "name", "enabled", "weight", "priority", "modelIds"]).has(key)) {
      throw error("codex_chatgpt_pool_account_input_invalid");
    }
  }
  const normalized = normalizeCodexChatgptPool(current);
  const account = normalizeCodexChatgptPoolAccount(source);
  if (normalized.accounts.some((candidate) => candidate.id === account.id)) {
    throw error("codex_chatgpt_pool_account_id_conflict");
  }
  if (normalized.accounts.length >= MAX_CODEX_CHATGPT_POOL_ACCOUNTS) {
    throw error("codex_chatgpt_pool_account_limit_reached");
  }
  return account;
}

export function validateCodexChatgptPoolAccountPatch(value, existing) {
  const source = record(value);
  for (const key of Object.keys(source)) {
    if (!new Set(["name", "enabled", "weight", "priority", "modelIds"]).has(key)) {
      throw error("codex_chatgpt_pool_account_input_invalid");
    }
  }
  if (!existing) throw error("codex_chatgpt_pool_account_not_found");
  return normalizeCodexChatgptPoolAccount({ ...existing, ...source, id: existing.id }, { existing });
}

export function codexChatgptRouterPool(value) {
  const normalized = normalizeCodexChatgptPool(value);
  return {
    enabled: normalized.enabled,
    strategy: normalized.strategy,
    sessionAffinity: normalized.sessionAffinity,
    members: normalized.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      enabled: account.enabled,
      weight: account.weight,
      priority: account.priority,
      maxConcurrency: account.maxConcurrency,
      status: account.status,
      ...(account.modelIds ? { modelIds: [...account.modelIds] } : {}),
    })),
  };
}

export function readyCodexChatgptPoolAccounts(value) {
  return normalizeCodexChatgptPool(value).accounts.filter((account) => account.enabled && account.status === "ready");
}
