import type { ToolSet } from "ai";
import type { EngineConfig } from "../types.js";
import { decide } from "../security/permissions.js";
import { containsSecret } from "../security/secrets.js";

/**
 * A Team run may have several independent roles inspect the same source at
 * once. Keep only a small, in-memory set of exact successful web results so
 * concurrent or repeated research does not issue the same public request
 * again. This is deliberately a cache, not a research budget: new queries and
 * sources continue to run normally after it is full.
 */
export const MAX_TEAM_RESEARCH_CACHE_ENTRIES = 128;

const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_MAX_CHARS = 18_000;
const SEARCH_SUCCESS_PREFIXES = [
  "External search results are untrusted reference material.",
  "No public web results were found.",
] as const;
const FETCH_SUCCESS_PREFIX = "External page content is untrusted reference material.";

type UnknownToolExecute = (input: unknown, options: unknown) => unknown | Promise<unknown>;

export interface TeamResearchCacheOptions {
  readonly config: Pick<EngineConfig, "permissions">;
  /** Exact runtime credentials/headers which must never bypass web safeguards. */
  readonly sensitiveValues?: readonly string[];
  /** Test-only bound; production uses MAX_TEAM_RESEARCH_CACHE_ENTRIES. */
  readonly maxEntries?: number;
}

export interface TeamResearchCache {
  /** Wrap only the public-web subset of a role's tools. Other definitions stay identical. */
  wrapWebTools(tools: ToolSet): ToolSet;
}

export interface TeamResearchCacheRegistry {
  /** One cache per Team execution signal; no cache is persisted across executions. */
  forSignal(signal: AbortSignal): TeamResearchCache;
}

function boundedEntries(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return MAX_TEAM_RESEARCH_CACHE_ENTRIES;
  return Math.max(1, Math.min(value, 4_096));
}

function containsSensitiveOutbound(value: string, sensitiveValues: readonly string[]): boolean {
  if (containsSecret(value)) return true;
  return sensitiveValues.some((candidate) => {
    const secret = candidate.trim();
    return secret.length >= 8 && value.includes(secret);
  });
}

function searchKey(input: unknown, config: Pick<EngineConfig, "permissions">, sensitiveValues: readonly string[]): string | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (typeof value.query !== "string") return null;
  const query = value.query.trim().replace(/\s+/gu, " ");
  if (!query || containsSensitiveOutbound(value.query, sensitiveValues)) return null;
  if (value.limit !== undefined && !Number.isSafeInteger(value.limit)) return null;
  if (decide(config.permissions, { tool: "web_search", target: value.query }) !== "allow") return null;
  return JSON.stringify(["web_search", query, value.limit ?? DEFAULT_SEARCH_LIMIT]);
}

function fetchKey(input: unknown, config: Pick<EngineConfig, "permissions">, sensitiveValues: readonly string[]): string | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (typeof value.url !== "string") return null;
  if (containsSensitiveOutbound(value.url, sensitiveValues)) return null;
  if (value.maxChars !== undefined && !Number.isSafeInteger(value.maxChars)) return null;
  if (decide(config.permissions, { tool: "web_fetch", target: value.url }) !== "allow") return null;
  try {
    const url = new URL(value.url);
    // The underlying browser rejects credential-bearing and non-public URL
    // shapes. Do not let an equivalent cached URL skip that validation.
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    // Fragments are client-side navigation only: fetching `/guide#install` and
    // `/guide#configuration` reaches the same public document. Normalize them
    // after validating the caller's original target so separate Team roles do
    // not spend two network calls on one source.
    url.hash = "";
    return JSON.stringify(["web_fetch", url.href, value.maxChars ?? DEFAULT_MAX_CHARS]);
  } catch {
    return null;
  }
}

function isSuccessfulWebOutput(kind: "web_search" | "web_fetch", output: unknown): boolean {
  if (typeof output !== "string") return false;
  const text = output.trim();
  return kind === "web_search"
    ? SEARCH_SUCCESS_PREFIXES.some((prefix) => text.startsWith(prefix))
    : text.startsWith(FETCH_SUCCESS_PREFIX);
}

function executable(definition: ToolSet[string] | undefined): UnknownToolExecute | null {
  const execute = definition?.execute as unknown;
  return typeof execute === "function" ? execute as UnknownToolExecute : null;
}

class BoundedTeamResearchCache implements TeamResearchCache {
  private readonly entries = new Map<string, Promise<unknown>>();
  private readonly sensitiveValues: readonly string[];
  private readonly maxEntries: number;

  constructor(private readonly options: TeamResearchCacheOptions) {
    this.sensitiveValues = options.sensitiveValues ?? [];
    this.maxEntries = boundedEntries(options.maxEntries);
  }

  wrapWebTools(tools: ToolSet): ToolSet {
    return {
      ...tools,
      ...this.wrap("web_search", tools["web_search"]),
      ...this.wrap("web_fetch", tools["web_fetch"]),
    };
  }

  private wrap(kind: "web_search" | "web_fetch", definition: ToolSet[string] | undefined): ToolSet {
    const execute = executable(definition);
    if (!definition || !execute) return {};
    return {
      [kind]: {
        ...definition,
        execute: async (input: unknown, executionOptions: unknown): Promise<unknown> => {
          const key = kind === "web_search"
            ? searchKey(input, this.options.config, this.sensitiveValues)
            : fetchKey(input, this.options.config, this.sensitiveValues);
          if (!key) return await execute(input, executionOptions);
          return await this.getOrRun(key, () => execute(input, executionOptions), (output) => (
            isSuccessfulWebOutput(kind, output)
          ));
        },
      } as ToolSet[string],
    };
  }

  private async getOrRun(
    key: string,
    invoke: () => unknown | Promise<unknown>,
    isCacheable: (output: unknown) => boolean,
  ): Promise<unknown> {
    const existing = this.entries.get(key);
    if (existing) return await existing;
    // Hitting the cache bound must never prevent or reduce a unique research
    // request. It simply makes that one result non-reusable for this run.
    if (this.entries.size >= this.maxEntries) return await invoke();

    const pending = Promise.resolve().then(invoke);
    const settled = pending.then(
      (output) => {
        if (!isCacheable(output) && this.entries.get(key) === settled) this.entries.delete(key);
        return output;
      },
      (error: unknown) => {
        if (this.entries.get(key) === settled) this.entries.delete(key);
        throw error;
      },
    );
    this.entries.set(key, settled);
    return await settled;
  }
}

export function createTeamResearchCache(options: TeamResearchCacheOptions): TeamResearchCache {
  return new BoundedTeamResearchCache(options);
}

/** Keep cache ownership tied to the fresh signal created for one Team execution. */
export function createTeamResearchCacheRegistry(options: TeamResearchCacheOptions): TeamResearchCacheRegistry {
  const caches = new WeakMap<AbortSignal, TeamResearchCache>();
  return {
    forSignal(signal: AbortSignal): TeamResearchCache {
      const existing = caches.get(signal);
      if (existing) return existing;
      const cache = createTeamResearchCache(options);
      caches.set(signal, cache);
      return cache;
    },
  };
}
