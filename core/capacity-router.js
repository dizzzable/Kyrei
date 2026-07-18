/**
 * Model capacity routing (OmniRoute-class, Kyrei-shaped).
 *
 * Goal: never stop a coding session because one API key hit a limit.
 * - Expand one logical model into ordered (provider, account, model) candidates
 * - Prefer spare accounts of the SAME model first (fill-first / spare-first)
 * - Then same model family on other configured providers (e.g. OpenRouter claude)
 * - Then explicit modelAssignments.fallbacks
 *
 * Does not invent credentials — only reorders ready targets from the registry.
 */

export const CAPACITY_STRATEGIES = Object.freeze([
  "spare-first",
  "fill-first",
  "round-robin",
  "least-used",
  "balanced",
  "priority",
]);

/** Logical families so "claude" can hop across Anthropic + OpenRouter, etc. */
export const MODEL_FAMILIES = Object.freeze([
  { id: "claude", match: /(claude|sonnet|opus|haiku)/i },
  { id: "gpt", match: /(^gpt-|o1|o3|o4|chatgpt)/i },
  { id: "grok", match: /grok/i },
  { id: "gemini", match: /gemini/i },
  { id: "deepseek", match: /deepseek/i },
  { id: "qwen", match: /(qwen|dashscope)/i },
  { id: "mistral", match: /(mistral|mixtral|codestral)/i },
  { id: "llama", match: /llama/i },
  { id: "kimi", match: /(kimi|moonshot)/i },
  { id: "glm", match: /(glm|zhipu|zai)/i },
]);

/**
 * Subscription shield — transport hygiene for paid seats (see engine subscription-shield).
 * Defaults ON in stealth so OOB installs protect expensive keys without extra clicks.
 * @param {unknown} raw
 */
export function normalizeSubscriptionShieldConfig(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const modes = new Set(["off", "standard", "stealth"]);
  const modeRaw = typeof source.mode === "string" ? source.mode.trim().toLowerCase() : "stealth";
  const mode = modes.has(modeRaw) ? modeRaw : "stealth";
  const enabled = source.enabled === false || mode === "off" ? false : true;
  const minIntervalMs = Number(source.minIntervalMs);
  const headerTimeoutMs = Number(source.headerTimeoutMs);
  const inactivityTimeoutMs = Number(source.inactivityTimeoutMs);
  const maxConnectionsPerOrigin = Number(source.maxConnectionsPerOrigin);
  const normalizedHeaderTimeout = Number.isFinite(headerTimeoutMs)
    ? Math.max(0, Math.min(120_000, Math.floor(headerTimeoutMs)))
    : 0;
  const normalizedInactivityTimeout = Number.isFinite(inactivityTimeoutMs)
    ? Math.max(0, Math.min(120_000, Math.floor(inactivityTimeoutMs)))
    : 0;
  return {
    enabled: enabled && mode !== "off",
    mode: enabled ? mode : "off",
    minIntervalMs: Number.isFinite(minIntervalMs)
      ? Math.max(0, Math.min(10_000, Math.floor(minIntervalMs)))
      : 75,
    connectTimeoutMs: normalizedHeaderTimeout,
    headerTimeoutMs: normalizedHeaderTimeout,
    inactivityTimeoutMs: normalizedInactivityTimeout,
    maxConnectionsPerOrigin: Number.isFinite(maxConnectionsPerOrigin)
      ? Math.max(1, Math.min(32, Math.floor(maxConnectionsPerOrigin)))
      : 4,
  };
}

/**
 * @param {unknown} raw
 */
export function normalizeCapacityConfig(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const strategy = CAPACITY_STRATEGIES.includes(source.strategy) ? source.strategy : "spare-first";
  return {
    enabled: source.enabled !== false,
    strategy,
    /** Prefer keeping at least one account unused until others fail (spare-first). */
    preferSpare: source.preferSpare !== false,
    /** Search other providers for same model family after local accounts exhaust. */
    crossProviderFamily: source.crossProviderFamily !== false,
    /** Transport + pacing protection for expensive subscription seats. */
    subscriptionShield: normalizeSubscriptionShieldConfig(source.subscriptionShield),
  };
}

export function familyIdForModel(modelId) {
  const id = String(modelId ?? "");
  for (const family of MODEL_FAMILIES) {
    if (family.match.test(id)) return family.id;
  }
  return null;
}

export function modelsShareFamily(a, b) {
  const fa = familyIdForModel(a);
  const fb = familyIdForModel(b);
  return Boolean(fa && fb && fa === fb);
}

/**
 * Dedupe runtime targets by provider+account+model.
 * @param {Array<Record<string, unknown>>} targets
 */
export function dedupeRuntimeTargets(targets) {
  const seen = new Set();
  const out = [];
  for (const target of Array.isArray(targets) ? targets : []) {
    if (!target?.providerId || !target?.model) continue;
    const key = `${target.providerId}\0${target.accountId ?? "primary"}\0${target.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/**
 * Build ordered candidate list for a turn.
 *
 * @param {object} options
 * @param {Array} options.primaryTargets  from privateRuntimeTargetsForConfig (multi-account)
 * @param {Array} [options.familyTargets] same family on other providers
 * @param {Array} [options.fallbackTargets] modelAssignments.fallbacks expanded
 * @param {{ enabled?: boolean, strategy?: string, preferSpare?: boolean }} [options.capacity]
 */
export function orderCapacityCandidates(options) {
  const capacity = normalizeCapacityConfig(options.capacity);
  const primary = dedupeRuntimeTargets(options.primaryTargets);
  const family = capacity.crossProviderFamily
    ? dedupeRuntimeTargets(options.familyTargets)
    : [];
  const fallbacks = dedupeRuntimeTargets(options.fallbackTargets);

  if (!capacity.enabled) {
    return dedupeRuntimeTargets([...primary, ...fallbacks]);
  }

  // spare-first / fill-first: keep primary order (pool already ordered that way)
  // least-used: sort by lastUsed if present on target metadata
  let orderedPrimary = primary;
  if (capacity.strategy === "least-used") {
    orderedPrimary = [...primary].sort((a, b) => {
      const la = Number(a.lastUsedAt) || 0;
      const lb = Number(b.lastUsedAt) || 0;
      return la - lb;
    });
  } else if (capacity.strategy === "round-robin") {
    // Pool router already RR-ordered; keep as-is
    orderedPrimary = primary;
  }

  // Family backups after all same-provider accounts; then explicit fallbacks
  return dedupeRuntimeTargets([...orderedPrimary, ...family, ...fallbacks]);
}

/**
 * Find sibling models on other providers that share a family with primaryModelId.
 * @param {object} config gateway config
 * @param {string} primaryProviderId
 * @param {string} primaryModelId
 * @returns {Array<{ providerId: string, modelId: string }>}
 */
export function listFamilyModelRefs(config, primaryProviderId, primaryModelId) {
  const family = familyIdForModel(primaryModelId);
  if (!family) return [];
  const out = [];
  for (const provider of config.providers ?? []) {
    if (!provider?.enabled || provider.id === primaryProviderId) continue;
    for (const model of provider.models ?? []) {
      if (!model?.id) continue;
      if (familyIdForModel(model.id) === family) {
        out.push({ providerId: provider.id, modelId: model.id });
      }
    }
  }
  return out;
}
