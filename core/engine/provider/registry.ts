/** Model registry (Phase 3). Requirements §7.1, §7.2. */

export interface ModelLimits {
  contextWindow?: number;
  maxOutput?: number;
}
export interface ModelCost {
  inputPerM: number;
  outputPerM: number;
}
/**
 * Coarse, static capability flags for the small curated registry below.
 *
 * NOT authoritative and NOT read by any orchestration decision. The real
 * capability gating (whether to send tools, thinking config, vision input,
 * etc.) lives in `model-capabilities.js`, which has live-provider provenance
 * and confidence. `caps` survives only as a display-only fallback: the gateway
 * `/api/models` handler spreads it first and then overwrites it with
 * `capabilities.features`, so a stale value here can never change behavior —
 * do not add runtime branches on `entry.caps.*`.
 */
export interface ModelCaps {
  tools: boolean;
  reasoning: boolean;
  streaming: boolean;
  vision: boolean;
}
export interface ModelEntry {
  id: string;
  provider: string;
  baseURL: string;
  limits: ModelLimits;
  cost: ModelCost;
  /** Display-only fallback metadata — see ModelCaps. Not a gating input. */
  caps: ModelCaps;
}

export interface ModelResolveHint {
  baseURL?: string;
  id?: string;
  provider?: string;
  protocol?: string;
}

/**
 * Anthropic first-party pricing, $ per 1M tokens. Without these entries every
 * Claude model resolved to `cost {0,0}`, which silently turned every
 * dollar-denominated budget (reliability.maxCostUsd, org soft/hard caps,
 * per-principal budgets) into a no-op.
 */
function anthropic(
  id: string,
  contextWindow: number,
  maxOutput: number,
  inputPerM: number,
  outputPerM: number,
): ModelEntry {
  return {
    id,
    provider: "anthropic",
    baseURL: "https://api.anthropic.com/v1",
    limits: { contextWindow, maxOutput },
    cost: { inputPerM, outputPerM },
    caps: { tools: true, reasoning: true, streaming: true, vision: true },
  };
}

const REGISTRY: Record<string, ModelEntry> = {
  "claude-opus-5": anthropic("claude-opus-5", 1_000_000, 128_000, 5, 25),
  "claude-opus-4-8": anthropic("claude-opus-4-8", 1_000_000, 128_000, 5, 25),
  "claude-opus-4-7": anthropic("claude-opus-4-7", 1_000_000, 128_000, 5, 25),
  "claude-opus-4-6": anthropic("claude-opus-4-6", 1_000_000, 128_000, 5, 25),
  "claude-sonnet-5": anthropic("claude-sonnet-5", 1_000_000, 128_000, 3, 15),
  "claude-sonnet-4-6": anthropic("claude-sonnet-4-6", 1_000_000, 128_000, 3, 15),
  "claude-haiku-4-5": anthropic("claude-haiku-4-5", 200_000, 64_000, 1, 5),
  "claude-fable-5": anthropic("claude-fable-5", 1_000_000, 128_000, 10, 50),
  // Pre-4.6 families are still selectable and still cost money. Without them a
  // workspace pinned to Opus 4.5 had no price at all, so every dollar budget
  // silently passed.
  "claude-opus-4-5": anthropic("claude-opus-4-5", 200_000, 64_000, 5, 25),
  "claude-sonnet-4-5": anthropic("claude-sonnet-4-5", 200_000, 64_000, 3, 15),
  "claude-opus-4-1": anthropic("claude-opus-4-1", 200_000, 32_000, 15, 75),
  "claude-opus-4-0": anthropic("claude-opus-4-0", 200_000, 32_000, 15, 75),
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    provider: "openai",
    baseURL: "https://api.openai.com/v1",
    limits: { contextWindow: 128_000, maxOutput: 16_384 },
    cost: { inputPerM: 0.15, outputPerM: 0.6 },
    caps: { tools: true, reasoning: false, streaming: true, vision: true },
  },
  "deepseek-chat": {
    id: "deepseek-chat",
    provider: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    limits: { contextWindow: 64_000, maxOutput: 8_192 },
    cost: { inputPerM: 0.27, outputPerM: 1.1 },
    caps: { tools: true, reasoning: false, streaming: true, vision: false },
  },
  "llama3.1:8b": {
    id: "llama3.1:8b",
    provider: "ollama",
    baseURL: "http://localhost:11434/v1",
    limits: { contextWindow: 131_072, maxOutput: 8_192 },
    cost: { inputPerM: 0, outputPerM: 0 },
    caps: { tools: true, reasoning: false, streaming: true, vision: false },
  },
};

const CANONICAL_PROTOCOLS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: Object.freeze(["anthropic-messages"]),
  openai: Object.freeze(["openai-chat", "openai-responses"]),
  deepseek: Object.freeze(["openai-chat"]),
  ollama: Object.freeze(["openai-chat"]),
});

function normalizedEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return undefined;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return undefined;
  }
}

function isCanonicalHint(entry: ModelEntry, hint?: ModelResolveHint): boolean {
  if (!hint) return true;
  if (hint.baseURL !== undefined) {
    const expected = normalizedEndpoint(entry.baseURL);
    const actual = normalizedEndpoint(hint.baseURL);
    if (!expected || !actual || expected !== actual) return false;
  }
  const protocols = CANONICAL_PROTOCOLS[entry.provider];
  if (hint.protocol !== undefined && protocols && !protocols.includes(hint.protocol)) return false;
  return true;
}

/**
 * Strip platform decoration from a model id.
 *
 * Bedrock serves `anthropic.claude-opus-4-5-v1:0` and Vertex
 * `claude-opus-4-5@20250101` — the same model, priced and bounded the same way,
 * under a namespaced id the registry could never match. Every such deployment
 * therefore resolved to `cost {0,0}` and unknown limits, which turned dollar
 * budgets into a no-op and left context accounting without a window.
 */
export function canonicalModelId(id: string): string {
  const found = String(id ?? "").trim().toLowerCase().match(/claude-[a-z0-9._-]+/);
  if (!found) return id;
  return found[0]
    .replace(/[@:][\w.-]*$/, "") // Vertex "@version", Bedrock ":0"
    .replace(/-v\d+$/, "") // Bedrock "-v1"
    .replace(/-\d{8}$/, ""); // dated snapshot
}

/** Resolve a model id; unknown endpoint/model combinations keep their limits unknown. */
export function resolve(id: string, hint?: ModelResolveHint): ModelEntry {
  const entry = REGISTRY[id];
  if (entry && isCanonicalHint(entry, hint)) {
    return { ...entry, baseURL: hint?.baseURL ?? entry.baseURL, provider: hint?.provider ?? entry.provider };
  }
  // Platform-hosted Claude: same model, namespaced id, different endpoint — so
  // neither the direct lookup nor `isCanonicalHint` can match. Limits are
  // identical across platforms; the PRICES are first-party rates used as an
  // approximation, because a budget guard that never fires is worse than one
  // that fires on a close number. Partner rates differ (see AWS/GCP pricing).
  if (hint?.protocol === "amazon-bedrock" || hint?.protocol === "google-vertex") {
    const platformEntry = REGISTRY[canonicalModelId(id)];
    if (platformEntry) {
      return {
        ...platformEntry,
        id: hint.id ?? id,
        provider: hint.provider ?? platformEntry.provider,
        baseURL: hint.baseURL ?? platformEntry.baseURL,
      };
    }
  }
  return {
    id: hint?.id ?? id,
    provider: hint?.provider ?? "custom",
    baseURL: hint?.baseURL ?? "http://localhost:11434/v1",
    limits: {},
    cost: { inputPerM: 0, outputPerM: 0 },
    caps: { tools: true, reasoning: false, streaming: true, vision: false },
  };
}

export function registerModel(entry: ModelEntry): void {
  REGISTRY[entry.id] = entry;
}

/** Enumerate all known models (for the gateway `/api/models` catalog). */
export function listModels(): ModelEntry[] {
  return Object.values(REGISTRY);
}

export function isLocalBaseURL(baseURL: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(baseURL);
}
