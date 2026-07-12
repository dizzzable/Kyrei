/** Model registry (Phase 3). Requirements §7.1, §7.2. */

export interface ModelLimits {
  contextWindow: number;
  maxOutput: number;
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

const ROLES: Record<string, string> = { default: "gpt-4o-mini", small: "gpt-4o-mini", plan: "gpt-4o-mini" };

/** Resolve a role or model id to an entry; unknown ids get safe defaults from the hint. */
export function resolve(roleOrId: string, hint?: { baseURL?: string; id?: string; provider?: string }): ModelEntry {
  const id = ROLES[roleOrId] ?? roleOrId;
  const entry = REGISTRY[id];
  if (entry) return { ...entry, baseURL: hint?.baseURL ?? entry.baseURL, provider: hint?.provider ?? entry.provider };
  return {
    id: hint?.id ?? id,
    provider: hint?.provider ?? "custom",
    baseURL: hint?.baseURL ?? "http://localhost:11434/v1",
    limits: { contextWindow: 32_000, maxOutput: 4_096 },
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
