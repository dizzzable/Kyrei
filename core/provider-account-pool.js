/**
 * In-memory routing for multiple credentials belonging to one provider.
 *
 * This module deliberately accepts and returns only public account metadata.
 * Credential lookup remains the responsibility of the gateway secret store.
 */

/** spare-first = fill-first (burn active, keep reserve accounts until needed). */
export const PROVIDER_ACCOUNT_POOL_STRATEGIES = [
  "balanced",
  "round-robin",
  "fill-first",
  "spare-first",
  "least-used",
];
export const PROVIDER_ACCOUNT_STATUSES = ["ready", "cooldown", "auth-required", "disabled"];

/**
 * Failure classes aligned with engine classifyProviderFailure.
 * Network / soft-auth never permanently park a seat on first blip (OmniRoute / codex-lb style).
 */
export const PROVIDER_FAILURE_CLASSES = [
  "network",
  "rate_limit",
  "server",
  "auth_definite",
  "auth_uncertain",
  "auth_soft",
  "client",
  "unknown",
];

const DEFAULT_BASE_COOLDOWN_MS = 1_000;
/** Short park for pure transport noise — unstable Wi‑Fi must not look like a ban. */
const DEFAULT_NETWORK_COOLDOWN_MS = 1_500;
// Providers commonly publish hourly/daily reset windows. Match the engine's
// bounded Retry-After parser so a valid long cooldown is not truncated to 5m.
const DEFAULT_MAX_COOLDOWN_MS = 24 * 60 * 60_000;
const DEFAULT_SESSION_LEASE_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_SESSION_LEASES = 10_000;
/** Soft 403 (WAF/CDN) needs consecutive strikes before auth-required. */
const DEFAULT_AUTH_SOFT_STRIKES = 3;
/** Definite 401 / invalid-key text: still one clear signal is enough. */
const DEFAULT_AUTH_DEFINITE_STRIKES = 1;
/** Ambiguous custom/proxy 401 needs a second consistent strike before parking. */
const DEFAULT_AUTH_UNCERTAIN_STRIKES = 2;
const MAX_MEMBERS = 256;
const MAX_NAME_LENGTH = 120;
const MAX_MEMBER_MODELS = 2_000;
const MAX_MODEL_ID_LENGTH = 512;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function integer(value, fallback, min, max) {
  const candidate = Number(value);
  if (!Number.isFinite(candidate)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(candidate)));
}

function normalizeAccountId(value, fallback) {
  const candidate = text(value).toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate) ? candidate : fallback;
}

function normalizeStrategy(value) {
  if (value === "spare-first") return "fill-first";
  if (value === "least-used") return "least-used";
  return PROVIDER_ACCOUNT_POOL_STRATEGIES.includes(value) ? value : "balanced";
}

function normalizeStatus(value, enabled) {
  if (!enabled) return "disabled";
  return PROVIDER_ACCOUNT_STATUSES.includes(value) && value !== "disabled" ? value : "ready";
}

function safeTimestamp(value) {
  const candidate = Number(value);
  return Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : 0;
}

function normalizeMemberModelIds(source) {
  if (!Object.hasOwn(source, "modelIds")) return undefined;
  const rows = Array.isArray(source.modelIds) ? source.modelIds : [];
  const seen = new Set();
  const modelIds = [];
  for (const row of rows.slice(0, MAX_MEMBER_MODELS)) {
    const modelId = text(row);
    if (
      !modelId
      || modelId.length > MAX_MODEL_ID_LENGTH
      || /[\u0000-\u001f\u007f]/.test(modelId)
      || seen.has(modelId)
    ) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}

function memberAllowsModel(member, modelId) {
  if (!Object.hasOwn(member, "modelIds")) return true;
  const requested = text(modelId);
  return Boolean(requested && member.modelIds.includes(requested));
}

/** Normalize one renderer-safe account descriptor and drop every unknown field. */
export function normalizeProviderAccountMember(value, fallbackId = "account-1", fallbackPriority = 0) {
  const source = object(value);
  const id = normalizeAccountId(source.id, fallbackId);
  const enabled = source.enabled !== false && source.status !== "disabled";
  const name = text(source.name, text(source.displayName, id)).slice(0, MAX_NAME_LENGTH);
  const status = normalizeStatus(source.status, enabled);
  const modelIds = normalizeMemberModelIds(source);
  return {
    id,
    name,
    enabled,
    weight: integer(source.weight, 1, 1, 100),
    priority: integer(source.priority, fallbackPriority, 0, 10_000),
    maxConcurrency: integer(source.maxConcurrency, 4, 1, 64),
    status,
    cooldownUntil: status === "cooldown" ? safeTimestamp(source.cooldownUntil) : 0,
    ...(modelIds !== undefined ? { modelIds } : {}),
  };
}

/** Normalize the complete public pool configuration without retaining credentials. */
export function normalizeProviderAccountPool(value) {
  const source = object(value);
  const rows = Array.isArray(source.members) ? source.members : [];
  const seen = new Set();
  const members = [];
  for (let index = 0; index < rows.length && members.length < MAX_MEMBERS; index += 1) {
    const member = normalizeProviderAccountMember(rows[index], `account-${index + 1}`, index);
    if (seen.has(member.id)) continue;
    seen.add(member.id);
    members.push(member);
  }
  return {
    version: 1,
    enabled: source.enabled === true,
    strategy: normalizeStrategy(source.strategy),
    sessionAffinity: source.sessionAffinity !== false,
    members,
  };
}

/** Parse an HTTP Retry-After value (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value * 1_000);
  if (typeof value !== "string" || !value.trim()) return 0;
  const candidate = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(candidate)) return Math.max(0, Math.floor(Number(candidate) * 1_000));
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

function sessionKey(value) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  return candidate && candidate.length <= 512 && !candidate.includes("\0") ? candidate : "";
}

function exclusions(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);
}

function accountIdFrom(value) {
  if (typeof value === "string") return value;
  return typeof value?.accountId === "string" ? value.accountId : "";
}

const DEFINITE_AUTH_RE =
  /invalid[_\s-]?api[_\s-]?key|incorrect api key|api key (?:is )?(?:invalid|revoked|expired)|unauthorized.*api key|authentication[_\s-]?required|invalid[_\s-]?token|token (?:is )?(?:invalid|expired|revoked)|invalid[_\s-]?credentials|credentials? (?:are )?(?:invalid|expired|revoked)|not authenticated|login required|bearer token|x-api-key|permission.?denied|access.?denied|account (?:suspended|disabled|banned|locked)|subscription (?:expired|inactive)|insufficient.?permissions/i;

function authEvidenceText(options = {}) {
  const parts = [
    options.message,
    options.code,
    options.reason,
    options.responseBody,
    typeof options.data === "string" ? options.data : options.data?.error?.message,
    options.data?.message,
    options.error?.message,
    options.error?.code,
  ];
  return parts.filter((part) => typeof part === "string" && part.trim()).join(" ").toLowerCase();
}

function hasExplicitInvalidKeyEvidence(options = {}) {
  return DEFINITE_AUTH_RE.test(authEvidenceText(options));
}

/** Normalize optional failure class from engine/gateway (drop unknown values). */
export function normalizeFailureClass(value) {
  return PROVIDER_FAILURE_CLASSES.includes(value) ? value : "";
}

/**
 * Derive failure class when the engine did not attach one (legacy callers / tests).
 * Prefer engine classifyProviderFailure — this is a statusCode-only fallback.
 */
export function inferFailureClass(options = {}) {
  const explicit = normalizeFailureClass(options.failureClass);
  if (explicit) return explicit;
  if (options.authRequired === true) return "auth_definite";
  if (options.disabled === true) return "client";
  const statusCode = Number.isFinite(Number(options.statusCode ?? options.status))
    ? Number(options.statusCode ?? options.status)
    : 0;
  if (statusCode === 401) return hasExplicitInvalidKeyEvidence(options) ? "auth_definite" : "auth_uncertain";
  if (statusCode === 403) return "auth_soft";
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 408 || statusCode === 425) return "network";
  if (statusCode >= 500) return "server";
  if (!statusCode && options.retryable === true) return "network";
  if (statusCode >= 400 && statusCode < 500) return "client";
  if (options.retryable === true) return "network";
  return "unknown";
}

export class ProviderAccountPoolRouter {
  constructor({
    config,
    now = () => Date.now(),
    baseCooldownMs = DEFAULT_BASE_COOLDOWN_MS,
    maxCooldownMs = DEFAULT_MAX_COOLDOWN_MS,
    networkCooldownMs = DEFAULT_NETWORK_COOLDOWN_MS,
    sessionLeaseTtlMs = DEFAULT_SESSION_LEASE_TTL_MS,
    maxSessionLeases = DEFAULT_MAX_SESSION_LEASES,
    authSoftStrikesRequired = DEFAULT_AUTH_SOFT_STRIKES,
    authDefiniteStrikesRequired = DEFAULT_AUTH_DEFINITE_STRIKES,
    authUncertainStrikesRequired = DEFAULT_AUTH_UNCERTAIN_STRIKES,
  } = {}) {
    if (typeof now !== "function") throw new Error("provider_account_pool_now_invalid");
    const normalized = normalizeProviderAccountPool(config);
    this.enabled = normalized.enabled;
    this.strategy = normalized.strategy;
    this.sessionAffinity = normalized.sessionAffinity;
    this.now = now;
    this.baseCooldownMs = integer(baseCooldownMs, DEFAULT_BASE_COOLDOWN_MS, 100, 60_000);
    this.networkCooldownMs = integer(networkCooldownMs, DEFAULT_NETWORK_COOLDOWN_MS, 100, 30_000);
    this.maxCooldownMs = integer(maxCooldownMs, DEFAULT_MAX_COOLDOWN_MS, this.baseCooldownMs, 24 * 60 * 60_000);
    this.sessionLeaseTtlMs = integer(sessionLeaseTtlMs, DEFAULT_SESSION_LEASE_TTL_MS, 60_000, 30 * 24 * 60 * 60_000);
    this.maxSessionLeases = integer(maxSessionLeases, DEFAULT_MAX_SESSION_LEASES, 1, 100_000);
    this.authSoftStrikesRequired = integer(authSoftStrikesRequired, DEFAULT_AUTH_SOFT_STRIKES, 1, 10);
    this.authDefiniteStrikesRequired = integer(authDefiniteStrikesRequired, DEFAULT_AUTH_DEFINITE_STRIKES, 1, 10);
    this.authUncertainStrikesRequired = integer(authUncertainStrikesRequired, DEFAULT_AUTH_UNCERTAIN_STRIKES, 1, 10);
    this.states = normalized.members.map((member, order) => ({
      member: { ...member },
      order,
      authRequired: member.status === "auth-required",
      cooldownUntil: member.status === "cooldown" ? member.cooldownUntil : 0,
      failures: 0,
      softAuthStrikes: 0,
      definiteAuthStrikes: 0,
      uncertainAuthStrikes: 0,
      lastFailureClass: "",
      inflight: 0,
      lastUsedAt: 0,
    }));
    this.stateById = new Map(this.states.map((state) => [state.member.id, state]));
    this.sessionLeases = new Map();
    this.activeAcquisitions = new Map();
    this.roundRobinCursor = 0;
    this.nextLeaseId = 1;
  }

  currentTime() {
    const value = Number(this.now());
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : Date.now();
  }

  statusOf(state, now = this.currentTime()) {
    if (!state.member.enabled) return "disabled";
    if (state.authRequired) return "auth-required";
    if (state.cooldownUntil > now) return "cooldown";
    return "ready";
  }

  publicState(state, now = this.currentTime()) {
    const status = this.statusOf(state, now);
    return {
      id: state.member.id,
      name: state.member.name,
      enabled: state.member.enabled,
      weight: state.member.weight,
      priority: state.member.priority,
      maxConcurrency: state.member.maxConcurrency,
      status,
      cooldownUntil: status === "cooldown" ? state.cooldownUntil : 0,
      inflight: state.inflight,
      lastUsedAt: state.lastUsedAt,
      failures: state.failures,
      softAuthStrikes: state.softAuthStrikes,
      definiteAuthStrikes: state.definiteAuthStrikes,
      uncertainAuthStrikes: state.uncertainAuthStrikes,
      ...(state.lastFailureClass ? { lastFailureClass: state.lastFailureClass } : {}),
      ...(Object.hasOwn(state.member, "modelIds") ? { modelIds: [...state.member.modelIds] } : {}),
    };
  }

  getConfig() {
    const now = this.currentTime();
    return {
      version: 1,
      enabled: this.enabled,
      strategy: this.strategy,
      sessionAffinity: this.sessionAffinity,
      members: this.states.map((state) => {
        const member = this.publicState(state, now);
        return {
          id: member.id,
          name: member.name,
          enabled: member.enabled,
          weight: member.weight,
          priority: member.priority,
          maxConcurrency: member.maxConcurrency,
          status: member.status,
          cooldownUntil: member.cooldownUntil,
          ...(Object.hasOwn(member, "modelIds") ? { modelIds: [...member.modelIds] } : {}),
        };
      }),
    };
  }

  listMembers() {
    const now = this.currentTime();
    return this.states.map((state) => this.publicState(state, now));
  }

  getMember(accountId) {
    const state = this.stateById.get(accountId);
    return state ? this.publicState(state) : null;
  }

  pruneSessionLeases(now = this.currentTime()) {
    for (const [key, lease] of this.sessionLeases) {
      if (now - lease.lastSeenAt >= this.sessionLeaseTtlMs || !this.stateById.has(lease.accountId)) {
        this.sessionLeases.delete(key);
      }
    }
  }

  rememberSession(sessionId, accountId, now = this.currentTime()) {
    const key = sessionKey(sessionId);
    if (!this.sessionAffinity || !key) return;
    this.pruneSessionLeases(now);
    this.sessionLeases.set(key, { accountId, lastSeenAt: now });
    while (this.sessionLeases.size > this.maxSessionLeases) {
      this.sessionLeases.delete(this.sessionLeases.keys().next().value);
    }
  }

  getSessionAccount(sessionId, modelId) {
    const key = sessionKey(sessionId);
    if (!this.sessionAffinity || !key) return null;
    const now = this.currentTime();
    this.pruneSessionLeases(now);
    const lease = this.sessionLeases.get(key);
    if (!lease) return null;
    const state = this.stateById.get(lease.accountId);
    if (!state || this.statusOf(state, now) !== "ready") {
      this.sessionLeases.delete(key);
      return null;
    }
    if (!memberAllowsModel(state.member, modelId)) return null;
    lease.lastSeenAt = now;
    return lease.accountId;
  }

  clearSession(sessionId) {
    const key = sessionKey(sessionId);
    return key ? this.sessionLeases.delete(key) : false;
  }

  clearAccountSessions(accountId) {
    for (const [key, lease] of this.sessionLeases) {
      if (lease.accountId === accountId) this.sessionLeases.delete(key);
    }
  }

  balancedStates(states) {
    return [...states].sort((left, right) => {
      // Weighted least-connections: a larger weight accepts proportionally
      // more concurrent work before another member becomes preferable.
      const leftLoad = (left.inflight + 1) / left.member.weight;
      const rightLoad = (right.inflight + 1) / right.member.weight;
      return leftLoad - rightLoad
        || left.lastUsedAt - right.lastUsedAt
        || left.member.priority - right.member.priority
        || left.order - right.order
        || left.member.id.localeCompare(right.member.id);
    });
  }

  roundRobinStates(states) {
    if (!this.states.length) return [];
    const positions = new Map(this.states.map((state, index) => [state.member.id, index]));
    return [...states].sort((left, right) => {
      const leftDistance = ((positions.get(left.member.id) ?? 0) - this.roundRobinCursor + this.states.length) % this.states.length;
      const rightDistance = ((positions.get(right.member.id) ?? 0) - this.roundRobinCursor + this.states.length) % this.states.length;
      return leftDistance - rightDistance || left.order - right.order;
    });
  }

  fillFirstStates(states) {
    return [...states].sort((left, right) => left.member.priority - right.member.priority
      || left.order - right.order
      || left.member.id.localeCompare(right.member.id));
  }

  leastUsedStates(states) {
    return [...states].sort((left, right) => (left.lastUsedAt || 0) - (right.lastUsedAt || 0)
      || left.member.priority - right.member.priority
      || left.order - right.order
      || left.member.id.localeCompare(right.member.id));
  }

  orderedCandidates({ sessionId, preferredAccountId, excludeAccountIds, modelId } = {}) {
    if (!this.enabled) return [];
    const now = this.currentTime();
    const excluded = exclusions(excludeAccountIds);
    const available = this.states.filter((state) => (
      this.statusOf(state, now) === "ready"
      && state.inflight < state.member.maxConcurrency
      && !excluded.has(state.member.id)
      && memberAllowsModel(state.member, modelId)
    ));
    if (!available.length) return [];

    const preferred = typeof preferredAccountId === "string" ? preferredAccountId : "";
    const affinityId = preferred && available.some((state) => state.member.id === preferred)
      ? preferred
      : this.getSessionAccount(sessionId, modelId);
    const affinity = affinityId ? available.find((state) => state.member.id === affinityId) : null;
    const remaining = affinity ? available.filter((state) => state !== affinity) : available;
    const ordered = this.strategy === "round-robin"
      ? this.roundRobinStates(remaining)
      : this.strategy === "fill-first"
        ? this.fillFirstStates(remaining)
        : this.strategy === "least-used"
          ? this.leastUsedStates(remaining)
          : this.balancedStates(remaining);
    return [...(affinity ? [affinity] : []), ...ordered].map((state) => this.publicState(state, now));
  }

  acquire({ sessionId, preferredAccountId, accountId, excludeAccountIds, modelId } = {}) {
    const candidates = this.orderedCandidates({ sessionId, preferredAccountId, excludeAccountIds, modelId });
    const selected = accountId
      ? candidates.find((candidate) => candidate.id === accountId)
      : candidates[0];
    if (!selected) return null;
    const state = this.stateById.get(selected.id);
    if (!state) return null;
    const now = this.currentTime();
    state.inflight += 1;
    state.lastUsedAt = now;
    this.rememberSession(sessionId, state.member.id, now);
    if (this.strategy === "round-robin" && this.states.length) {
      this.roundRobinCursor = (state.order + 1) % this.states.length;
    }
    const leaseId = `account-pool-lease-${this.nextLeaseId++}`;
    this.activeAcquisitions.set(leaseId, state.member.id);
    return {
      leaseId,
      accountId: state.member.id,
      member: this.publicState(state, now),
    };
  }

  release(lease) {
    const leaseId = typeof lease === "string" ? lease : lease?.leaseId;
    if (typeof leaseId !== "string") return false;
    const accountId = this.activeAcquisitions.get(leaseId);
    if (!accountId) return false;
    this.activeAcquisitions.delete(leaseId);
    const state = this.stateById.get(accountId);
    if (state) state.inflight = Math.max(0, state.inflight - 1);
    return true;
  }

  reportSuccess(account, { sessionId } = {}) {
    const accountId = accountIdFrom(account);
    const state = this.stateById.get(accountId);
    if (!state) return null;
    const now = this.currentTime();
    state.failures = 0;
    state.softAuthStrikes = 0;
    state.definiteAuthStrikes = 0;
    state.uncertainAuthStrikes = 0;
    state.lastFailureClass = "";
    state.authRequired = false;
    state.cooldownUntil = 0;
    state.lastUsedAt = now;
    if (state.member.enabled) this.rememberSession(sessionId, accountId, now);
    return this.publicState(state, now);
  }

  /** Clear ephemeral strikes/cooldowns without changing saved enablement or credentials. */
  resetRuntime(account) {
    const requestedId = accountIdFrom(account);
    const targets = requestedId ? [this.stateById.get(requestedId)].filter(Boolean) : this.states;
    if (requestedId && !targets.length) return null;
    const now = this.currentTime();
    for (const state of targets) {
      state.failures = 0;
      state.softAuthStrikes = 0;
      state.definiteAuthStrikes = 0;
      state.uncertainAuthStrikes = 0;
      state.lastFailureClass = "";
      state.authRequired = false;
      state.cooldownUntil = 0;
      this.clearAccountSessions(state.member.id);
    }
    return requestedId ? this.publicState(targets[0], now) : this.listMembers();
  }

  /**
   * Apply a cooldown without elevating auth-required.
   * Network uses a short base so blips recover quickly; 429/5xx use exponential + Retry-After.
   */
  applyCooldown(state, now, { failureClass, options = {} } = {}) {
    const statusCode = Number.isFinite(Number(options.statusCode ?? options.status))
      ? Number(options.statusCode ?? options.status)
      : 0;
    const explicitMs = Number.isFinite(Number(options.retryAfterMs))
      ? Math.max(0, Math.floor(Number(options.retryAfterMs)))
      : 0;
    const retryAfterMs = parseRetryAfterMs(options.retryAfter, now);
    const networkish = failureClass === "network" || statusCode === 408 || statusCode === 425;
    const base = networkish ? this.networkCooldownMs : this.baseCooldownMs;
    const exponential = Math.min(this.maxCooldownMs, base * (2 ** Math.max(0, state.failures - 1)));
    // Soft-auth probe windows stay short until the multi-strike threshold trips.
    const softProbe = failureClass === "auth_soft"
      ? Math.min(this.maxCooldownMs, this.baseCooldownMs * (2 ** Math.max(0, state.softAuthStrikes - 1)))
      : 0;
    const delay = Math.min(
      this.maxCooldownMs,
      Math.max(networkish ? this.networkCooldownMs : 0, exponential, softProbe, explicitMs, retryAfterMs),
    );
    state.authRequired = false;
    state.cooldownUntil = now + Math.max(delay, networkish ? this.networkCooldownMs : this.baseCooldownMs);
  }

  reportFailure(account, options = {}) {
    const accountId = accountIdFrom(account);
    const state = this.stateById.get(accountId);
    if (!state) return null;
    const now = this.currentTime();
    const statusCode = Number.isFinite(Number(options.statusCode ?? options.status))
      ? Number(options.statusCode ?? options.status)
      : 0;
    const failureClass = inferFailureClass(options);
    state.failures = Math.min(31, state.failures + 1);
    state.lastFailureClass = failureClass;

    if (options.disabled === true) {
      state.member.enabled = false;
      state.authRequired = false;
      state.cooldownUntil = 0;
      state.softAuthStrikes = 0;
      state.definiteAuthStrikes = 0;
      state.uncertainAuthStrikes = 0;
    } else if (options.authRequired === true || failureClass === "auth_definite") {
      // Explicit flag or hard 401 / invalid-key: still multi-strike configurable (default 1).
      state.softAuthStrikes = 0;
      state.uncertainAuthStrikes = 0;
      state.definiteAuthStrikes = Math.min(31, state.definiteAuthStrikes + 1);
      if (state.definiteAuthStrikes >= this.authDefiniteStrikesRequired) {
        state.authRequired = true;
        state.cooldownUntil = 0;
      } else {
        this.applyCooldown(state, now, { failureClass: "auth_definite", options });
      }
    } else if (failureClass === "auth_uncertain") {
      state.softAuthStrikes = 0;
      state.definiteAuthStrikes = 0;
      state.uncertainAuthStrikes = Math.min(31, state.uncertainAuthStrikes + 1);
      if (state.uncertainAuthStrikes >= this.authUncertainStrikesRequired) {
        state.authRequired = true;
        state.cooldownUntil = 0;
      } else {
        this.applyCooldown(state, now, { failureClass: "auth_uncertain", options });
      }
    } else if (failureClass === "auth_soft") {
      // Soft 403 (CDN/WAF/geo): cooldown-only; never escalate this class to auth-required.
      state.uncertainAuthStrikes = 0;
      state.definiteAuthStrikes = 0;
      state.softAuthStrikes = Math.min(31, state.softAuthStrikes + 1);
      this.applyCooldown(state, now, { failureClass: "auth_soft", options });
    } else {
      // Network / rate-limit / server / client / unknown — never escalate to auth-required here.
      // A successful request later clears strikes; a transport blip also resets soft-auth accumulation
      // so intermittent 403+network cannot slowly "ban" a healthy seat.
      if (failureClass === "network" || failureClass === "rate_limit" || failureClass === "server") {
        state.softAuthStrikes = 0;
        state.uncertainAuthStrikes = 0;
      }
      const retryable = options.retryable === true
        || failureClass === "network"
        || failureClass === "rate_limit"
        || failureClass === "server"
        || (options.retryable !== false && (!statusCode || statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500));
      if (retryable) {
        this.applyCooldown(state, now, { failureClass, options });
      }
    }

    if (this.statusOf(state, now) !== "ready") this.clearAccountSessions(accountId);
    return this.publicState(state, now);
  }
}
