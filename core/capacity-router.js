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
 * @param {unknown} raw
 */
export function normalizeCapacityConfig(raw) {
  const source = /** @type {{ enabled?: boolean, strategy?: string, preferSpare?: boolean, crossProviderFamily?: boolean }} */ (
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  );
  const strategy = CAPACITY_STRATEGIES.includes(source.strategy) ? source.strategy : "spare-first";
  return {
    enabled: source.enabled !== false,
    strategy,
    /** Prefer keeping at least one account unused until others fail (spare-first). */
    preferSpare: source.preferSpare !== false,
    /** Search other providers for same model family after local accounts exhaust. */
    crossProviderFamily: source.crossProviderFamily !== false,
    // Any legacy `subscriptionShield` block is dropped here: the transport layer
    // it configured was removed in v0.7.7 and provider SDKs own their own
    // streaming lifecycle. Normalizing it away keeps it out of the saved config.
  };
}

/**
 * Translate the workspace-wide Capacity strategy into a provider account-pool
 * strategy.
 *
 * The pool is the only layer that can honour these: it holds per-account
 * inflight counts, `lastUsedAt`, weight, priority and cooldown. The runtime
 * targets this router orders carry none of that, which is why the strategy
 * could never mean anything here — `least-used` sorted every candidate by the
 * same missing field and left the order untouched.
 *
 * Mappings follow the shipped hint text: "spare-first" is *burn the active
 * account and keep a reserve", i.e. fill-first, and "priority" is documented as
 * "same as fill-first for pools". With `preferSpare` off the user is asking for
 * no cold reserve at all, so load is spread instead.
 *
 * @param {{ strategy?: string, preferSpare?: boolean }} [capacity]
 * @returns {"balanced" | "round-robin" | "fill-first" | "least-used"}
 */
export function poolStrategyForCapacity(capacity) {
  const source = capacity && typeof capacity === "object" ? capacity : {};
  switch (source.strategy) {
    case "spare-first":
    case "fill-first":
    case "priority":
      // `preferSpare` only means anything against a reserve-keeping strategy —
      // "keep at least one key cold". Checking it before the switch threw away
      // an explicitly chosen round-robin or least-used, which it says nothing
      // about.
      return source.preferSpare === false ? "balanced" : "fill-first";
    case "round-robin":
      return "round-robin";
    case "least-used":
      return "least-used";
    default:
      return "balanced";
  }
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

  // `primary` arrives already ordered by the provider's account pool, which is
  // the only layer holding the per-account state (inflight, lastUsedAt, weight,
  // priority, cooldown) that a strategy needs. Runtime targets carry none of
  // it, so re-sorting here cannot implement any strategy — an earlier
  // `least-used` branch sorted every candidate by an absent `lastUsedAt`, read
  // it as 0, and left the order exactly as it found it.
  //
  // `capacity.strategy` reaches the pool as its default instead; see
  // poolStrategyForCapacity. What is left for this layer is the chain order:
  // every account on the primary provider, then same-family models elsewhere,
  // then the explicit fallbacks.
  return dedupeRuntimeTargets([...primary, ...family, ...fallbacks]);
}

/**
 * Find sibling models on other providers that share a family with primaryModelId.
 * @param {{ providers?: Array<{ id?: string, enabled?: boolean, models?: Array<{ id?: string }> }> }} config gateway config
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
