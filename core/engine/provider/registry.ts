/** Model registry (Phase 3). Requirements §7.1, §7.2. */

export interface ModelLimits {
  contextWindow?: number;
  maxOutput?: number;
}
export interface ModelCost {
  inputPerM: number;
  outputPerM: number;
}
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
  caps: ModelCaps;
}

export interface ModelResolveHint {
  baseURL?: string;
  id?: string;
  provider?: string;
  protocol?: string;
}

const REGISTRY: Record<string, ModelEntry> = {
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

/** Resolve a model id; unknown endpoint/model combinations keep their limits unknown. */
export function resolve(id: string, hint?: ModelResolveHint): ModelEntry {
  const entry = REGISTRY[id];
  if (entry && isCanonicalHint(entry, hint)) {
    return { ...entry, baseURL: hint?.baseURL ?? entry.baseURL, provider: hint?.provider ?? entry.provider };
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
