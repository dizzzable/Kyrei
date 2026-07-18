/**
 * Employee / principal access tokens (P2 governance).
 *
 * Plain token is shown once at create/regenerate. Only SHA-256 hashes live in
 * secrets. Public metadata (label, prefix, budgets, enabled) lives in config.
 *
 * Token format: kyrei_at_<base64url(32 bytes)>
 * Header: Authorization: Bearer <token>  or  X-Kyrei-Access-Token: <token>
 *
 * Desktop still uses the per-launch gateway capability token. Access tokens
 * tag usage for chargeback and optional hard budgets; when
 * accessControl.requireToken is true, /api/prompt also requires a valid AT.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  budgetWindowStartMs,
  evaluateUsageBudget,
  normalizeUsageBudgetConfig,
} from "./usage-budget.js";

const MAX_PRINCIPALS = 256;
const MAX_LABEL = 120;
const MAX_ALLOWED_MODELS = 512;
const MAX_MODEL_REF = 640;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOKEN_PREFIX = "kyrei_at_";

export class AccessTokenError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "AccessTokenError";
    this.code = code;
    this.status = status;
  }
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, max = MAX_LABEL) {
  if (typeof value !== "string") return "";
  const t = value.trim();
  if (!t || /[\u0000-\u001f\u007f]/.test(t)) return "";
  return t.slice(0, max);
}

function positiveOrNull(value, max) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, n);
}

/**
 * Normalise a model route visible through the company gateway.
 *
 * The first slash is the provider boundary. Model ids themselves may contain
 * slashes (for example a hosted open-weight model), so they are intentionally
 * left opaque after that boundary.
 */
export function normalizeAllowedModelRefs(value) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const refs = [];
  for (const raw of rows.slice(0, MAX_ALLOWED_MODELS)) {
    const ref = text(raw, MAX_MODEL_REF);
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) continue;
    const providerId = ref.slice(0, slash).toLowerCase();
    const modelId = ref.slice(slash + 1);
    if (!ID_RE.test(providerId) || !modelId || /[\u0000-\u001f\u007f]/.test(modelId)) continue;
    const normalized = `${providerId}/${modelId}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    refs.push(normalized);
  }
  return refs;
}

function normalizeExpiresAt(value) {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 80) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function isPrincipalExpired(principal, now = Date.now()) {
  const expiresAt = normalizeExpiresAt(principal?.expiresAt);
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp <= now;
}

/** Empty scope preserves legacy unrestricted tokens. New owner flows select it explicitly. */
export function isModelRefAllowed(principal, providerId, modelId) {
  const allowedModels = normalizeAllowedModelRefs(principal?.allowedModels);
  if (allowedModels.length === 0) return true;
  return allowedModels.includes(`${String(providerId ?? "").toLowerCase()}/${String(modelId ?? "")}`);
}

export function hashAccessToken(token) {
  return createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
}

export function mintAccessTokenPlain() {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function isAccessTokenFormat(token) {
  return typeof token === "string"
    && token.startsWith(TOKEN_PREFIX)
    && token.length >= TOKEN_PREFIX.length + 16
    && token.length <= 200;
}

function normalizePrincipal(raw, index = 0) {
  const source = object(raw);
  const idRaw = text(source.id, 64).toLowerCase();
  const id = ID_RE.test(idRaw) ? idRaw : `principal-${index + 1}`;
  const label = text(source.label, MAX_LABEL) || id;
  const prefix = text(source.prefix, 24) || "kyrei_at_…";
  const createdAt = text(source.createdAt, 40) || new Date().toISOString();
  const lastUsedAt = text(source.lastUsedAt, 40) || undefined;
  const expiresAt = normalizeExpiresAt(source.expiresAt);
  const budget = normalizeUsageBudgetConfig({
    enabled: true,
    window: source.budgetWindow === "month" ? "month" : "day",
    softCostUsd: source.softCostUsd,
    hardCostUsd: source.hardCostUsd,
    softTokens: source.softTokens,
    hardTokens: source.hardTokens,
  });
  return {
    id,
    label,
    prefix,
    enabled: source.enabled !== false,
    createdAt,
    ...(lastUsedAt ? { lastUsedAt } : {}),
    softCostUsd: budget.softCostUsd,
    hardCostUsd: budget.hardCostUsd,
    softTokens: budget.softTokens,
    hardTokens: budget.hardTokens,
    budgetWindow: budget.window,
    allowedModels: normalizeAllowedModelRefs(source.allowedModels),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

/**
 * Public access-control config (no hashes).
 * @param {unknown} raw
 */
export function normalizeAccessControl(raw) {
  const source = object(raw);
  const seen = new Set();
  const principals = [];
  for (const [index, row] of (Array.isArray(source.principals) ? source.principals : []).slice(0, MAX_PRINCIPALS).entries()) {
    const principal = normalizePrincipal(row, index);
    if (seen.has(principal.id)) continue;
    seen.add(principal.id);
    principals.push(principal);
  }
  return {
    requireToken: source.requireToken === true,
    principals,
  };
}

/**
 * @param {unknown} raw secrets.accessTokenHashes
 * @returns {Record<string, string>}
 */
export function normalizeAccessTokenHashes(raw) {
  const source = object(raw);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [id, hash] of Object.entries(source)) {
    if (!ID_RE.test(id)) continue;
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash)) continue;
    out[id] = hash.toLowerCase();
  }
  return out;
}

export function publicAccessControl(control) {
  const normalized = normalizeAccessControl(control);
  return {
    requireToken: normalized.requireToken,
    principals: normalized.principals.map((p) => ({ ...p })),
  };
}

/**
 * Create a new principal + plain token (caller must persist hash once).
 * @param {object} options
 * @param {string} options.label
 * @param {object[]} [options.existing]
 * @param {Partial<import('./usage-budget.js').UsageBudgetConfig>} [options.budget]
 */
export function createAccessPrincipal(options) {
  const existing = Array.isArray(options.existing) ? options.existing : [];
  const used = new Set(existing.map((p) => p.id));
  let suffix = 1;
  let id = `user-${suffix}`;
  while (used.has(id)) {
    suffix += 1;
    id = `user-${suffix}`;
  }
  const plain = mintAccessTokenPlain();
  const hash = hashAccessToken(plain);
  const prefix = `${plain.slice(0, 12)}…`;
  const budget = normalizeUsageBudgetConfig({
    enabled: true,
    window: options.budget?.window ?? "day",
    softCostUsd: options.budget?.softCostUsd,
    hardCostUsd: options.budget?.hardCostUsd,
    softTokens: options.budget?.softTokens,
    hardTokens: options.budget?.hardTokens,
  });
  const principal = normalizePrincipal({
    id,
    label: text(options.label, MAX_LABEL) || id,
    prefix,
    enabled: true,
    createdAt: new Date().toISOString(),
    softCostUsd: budget.softCostUsd,
    hardCostUsd: budget.hardCostUsd,
    softTokens: budget.softTokens,
    hardTokens: budget.hardTokens,
    budgetWindow: budget.window,
    allowedModels: options.allowedModels,
    expiresAt: options.expiresAt,
  });
  return { principal, plain, hash };
}

/**
 * Regenerate secret for an existing principal id.
 */
export function regenerateAccessPrincipal(principal) {
  if (!principal?.id) throw new AccessTokenError("access_token_not_found", 404);
  const plain = mintAccessTokenPlain();
  const hash = hashAccessToken(plain);
  const prefix = `${plain.slice(0, 12)}…`;
  return {
    principal: {
      ...normalizePrincipal(principal),
      prefix,
    },
    plain,
    hash,
  };
}

/**
 * Extract raw access token from HTTP headers (not the launch gateway token).
 * @param {import('http').IncomingMessage} req
 */
export function extractAccessTokenFromRequest(req) {
  const headers = req?.headers ?? {};
  const dedicated = headers["x-kyrei-access-token"];
  if (typeof dedicated === "string" && isAccessTokenFormat(dedicated.trim())) {
    return dedicated.trim();
  }
  const auth = typeof headers.authorization === "string" ? headers.authorization : "";
  const match = /^Bearer\s+(\S+)/i.exec(auth);
  if (match?.[1] && isAccessTokenFormat(match[1])) return match[1];
  return null;
}

function hashesEqual(a, b) {
  try {
    const left = Buffer.from(String(a), "utf8");
    const right = Buffer.from(String(b), "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/**
 * Resolve principal from plain token + public control + secret hashes.
 * @returns {{ principal: object, id: string } | null}
 */
export function resolveAccessPrincipal(plain, control, hashes) {
  if (!isAccessTokenFormat(plain)) return null;
  const digest = hashAccessToken(plain);
  const hashMap = normalizeAccessTokenHashes(hashes);
  const access = normalizeAccessControl(control);
  for (const principal of access.principals) {
    const expected = hashMap[principal.id];
    if (!expected || !hashesEqual(expected, digest)) continue;
    if (!principal.enabled) {
      throw new AccessTokenError("access_token_disabled", 403);
    }
    if (isPrincipalExpired(principal)) {
      throw new AccessTokenError("access_token_expired", 403);
    }
    return { principal, id: principal.id };
  }
  return null;
}

/**
 * Evaluate per-principal budget against filtered ledger events.
 * @param {object} principal
 * @param {Array<{ accessTokenId?: string, totalTokens?: number, costUsd?: number, ts?: string }>} events
 */
export function evaluatePrincipalBudget(principal, events) {
  if (!principal) {
    return evaluateUsageBudget({ enabled: false }, { totalTokens: 0, costUsd: 0, requestCount: 0 });
  }
  const window = principal.budgetWindow === "month" ? "month" : "day";
  const sinceMs = budgetWindowStartMs(window);
  let totalTokens = 0;
  let costUsd = 0;
  let requestCount = 0;
  for (const event of events) {
    if (event.accessTokenId !== principal.id) continue;
    const t = Date.parse(event.ts ?? "");
    if (Number.isFinite(t) && t < sinceMs) continue;
    requestCount += 1;
    totalTokens += Number(event.totalTokens) || 0;
    costUsd += Number(event.costUsd) || 0;
  }
  return evaluateUsageBudget({
    enabled: true,
    window,
    softCostUsd: principal.softCostUsd,
    hardCostUsd: principal.hardCostUsd,
    softTokens: principal.softTokens,
    hardTokens: principal.hardTokens,
  }, { totalTokens, costUsd, requestCount });
}

export function patchPrincipal(principal, patch) {
  const source = object(patch);
  const next = {
    ...normalizePrincipal(principal),
    ...(source.label !== undefined ? { label: text(source.label, MAX_LABEL) || principal.label } : {}),
    ...(source.enabled !== undefined ? { enabled: source.enabled === true } : {}),
    ...(source.allowedModels !== undefined ? { allowedModels: source.allowedModels } : {}),
    ...(Object.hasOwn(source, "expiresAt") ? { expiresAt: source.expiresAt } : {}),
  };
  if (
    source.softCostUsd !== undefined
    || source.hardCostUsd !== undefined
    || source.softTokens !== undefined
    || source.hardTokens !== undefined
    || source.budgetWindow !== undefined
  ) {
    const budget = normalizeUsageBudgetConfig({
      enabled: true,
      window: source.budgetWindow === "month" || source.budgetWindow === "day"
        ? source.budgetWindow
        : principal.budgetWindow,
      softCostUsd: source.softCostUsd !== undefined ? source.softCostUsd : principal.softCostUsd,
      hardCostUsd: source.hardCostUsd !== undefined ? source.hardCostUsd : principal.hardCostUsd,
      softTokens: source.softTokens !== undefined ? source.softTokens : principal.softTokens,
      hardTokens: source.hardTokens !== undefined ? source.hardTokens : principal.hardTokens,
    });
    next.softCostUsd = budget.softCostUsd;
    next.hardCostUsd = budget.hardCostUsd;
    next.softTokens = budget.softTokens;
    next.hardTokens = budget.hardTokens;
    next.budgetWindow = budget.window;
  }
  return normalizePrincipal(next);
}

export { positiveOrNull };
