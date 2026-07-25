/**
 * Wave B2 — prompt-cache packing.
 *
 * Keeps a stable system prefix (cache-friendly) and attaches provider-specific
 * cache breakpoints when the protocol supports them (Anthropic ephemeral).
 * OpenAI-class models rely on automatic prefix caching when the system text is
 * stable and ordered first — we only ensure assembly order.
 *
 * Volatile tail (project context) stays after the stable contract so cache hits
 * cover policy/tools and only the project slice invalidates.
 */

import type { ModelMessage, ToolSet } from "ai";
import type { ProviderProtocol } from "../types.js";
import type { ProviderOptionsMap } from "../provider/build.js";

export interface SystemPromptParts {
  /** Immutable-ish harness + tools + mode (prompt-cache friendly). */
  stable: string;
  /** Project context / late guidance that changes more often. */
  volatile?: string;
}

export interface PackedPrompt {
  /**
   * When set, pass as streamText `instructions` / `system` (non-Anthropic path).
   * Single string = stable + volatile joined.
   */
  instructions?: string;
  /**
   * When set, prepend these system messages and omit `instructions`
   * so Anthropic cacheControl can attach per-message.
   */
  systemMessages?: ModelMessage[];
  /** Whether Anthropic-style cache breakpoints were applied. */
  cacheBreakpoints: boolean;
  protocol: ProviderProtocol | "unknown";
}

const ANTHROPIC_CACHE = {
  anthropic: {
    cacheControl: { type: "ephemeral" as const },
  },
};

function isAnthropic(protocol: ProviderProtocol | string | undefined): boolean {
  return protocol === "anthropic-messages";
}

/** Join parts deterministically (same as buildSystemPrompt for snapshot parity). */
export function joinSystemParts(parts: SystemPromptParts): string {
  if (!parts.volatile?.trim()) return parts.stable;
  return `${parts.stable}\n\n${parts.volatile.trim()}`;
}

/**
 * Pack system content for a protocol.
 * - anthropic-messages: system messages with cacheControl on the stable block
 * - others: single instructions string (stable prefix first)
 */
export function packSystemForCache(
  parts: SystemPromptParts | string | undefined,
  protocol?: ProviderProtocol | string,
): PackedPrompt {
  const proto = (protocol ?? "unknown") as ProviderProtocol | "unknown";
  if (!parts) {
    return { cacheBreakpoints: false, protocol: proto };
  }

  const normalized: SystemPromptParts =
    typeof parts === "string"
      ? { stable: parts }
      : { stable: parts.stable, ...(parts.volatile?.trim() ? { volatile: parts.volatile.trim() } : {}) };

  if (!normalized.stable.trim() && !normalized.volatile?.trim()) {
    return { cacheBreakpoints: false, protocol: proto };
  }

  if (isAnthropic(proto)) {
    const systemMessages: ModelMessage[] = [];
    if (normalized.stable.trim()) {
      systemMessages.push({
        role: "system",
        content: normalized.stable.trim(),
        providerOptions: ANTHROPIC_CACHE,
      } as ModelMessage);
    }
    if (normalized.volatile?.trim()) {
      // Volatile tail: no long-lived cache breakpoint (still a system message).
      systemMessages.push({
        role: "system",
        content: normalized.volatile.trim(),
      } as ModelMessage);
    }
    return {
      systemMessages,
      cacheBreakpoints: true,
      protocol: proto,
    };
  }

  return {
    instructions: joinSystemParts(normalized),
    cacheBreakpoints: false,
    protocol: proto,
  };
}

/**
 * Merge providerOptions without clobbering reasoning/thinking keys.
 * Anthropic cache is message-level; this only ensures the bag stays intact.
 */
export function mergeProviderOptions(
  base: ProviderOptionsMap | undefined,
  extra: ProviderOptionsMap | undefined,
): ProviderOptionsMap | undefined {
  if (!base && !extra) return undefined;
  if (!base) return extra;
  if (!extra) return base;
  const out: ProviderOptionsMap = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = { ...(out[key] ?? {}), ...value };
  }
  return out;
}

/**
 * Wave B3 — cache the tool-schema block on Anthropic.
 *
 * Tool JSON schemas are large and constant for the whole session, yet they are
 * re-sent on every provider step. Anthropic caches by longest prefix, so a
 * single `cache_control` breakpoint on the LAST tool covers the entire tools
 * block. No-op for other protocols (they rely on automatic prefix caching).
 *
 * The tool objects in `tools` are shared references across fallback candidates,
 * so we clone the last tool (and its providerOptions) instead of mutating it —
 * a mutation would leak an Anthropic breakpoint onto non-Anthropic candidates.
 */
export function applyToolCacheBreakpoint(
  tools: ToolSet | undefined,
  protocol?: ProviderProtocol | string,
): ToolSet | undefined {
  if (!tools || !isAnthropic(protocol)) return tools;
  const keys = Object.keys(tools);
  if (keys.length === 0) return tools;
  const lastKey = keys[keys.length - 1]!;
  const lastTool = tools[lastKey] as { providerOptions?: ProviderOptionsMap };
  const cachedTool = {
    ...lastTool,
    providerOptions: mergeProviderOptions(lastTool.providerOptions, ANTHROPIC_CACHE),
  };
  return { ...tools, [lastKey]: cachedTool } as ToolSet;
}

/**
 * Wave B3 — cache the conversation-history prefix on Anthropic.
 *
 * Within a single turn the multi-step tool loop re-sends the same growing
 * history on every step. A breakpoint at the end of the last input message
 * caches that prefix so each tool step reuses it. Between turns the anchor
 * shifts forward — that is fine; caching is best-effort with no miss penalty.
 *
 * Clones the last message instead of mutating it (the array/messages may be
 * shared) and merges providerOptions so existing keys (thinking/reasoning)
 * survive. For the last content part with no own cache_control, the Anthropic
 * provider falls back to `message.providerOptions`, so a message-level
 * breakpoint lands cleanly at the end of that message.
 */
export function applyHistoryCacheBreakpoint(
  messages: ModelMessage[],
  protocol?: ProviderProtocol | string,
): ModelMessage[] {
  if (!isAnthropic(protocol) || messages.length === 0) return messages;
  const last = messages[messages.length - 1] as ModelMessage & {
    providerOptions?: ProviderOptionsMap;
  };
  const cached = {
    ...last,
    providerOptions: mergeProviderOptions(last.providerOptions, ANTHROPIC_CACHE),
  } as ModelMessage;
  return [...messages.slice(0, -1), cached];
}

/** Human-readable routing note for docs / settings (Wave B3 companion). */
export const ROLE_ROUTING_DEFAULTS = [
  "Main / session model: default strong model for chat turns.",
  "worker: cheap/fast for read-only subagents, clean-context review, and summary LLM pass.",
  "plan + build: strong models (reasoning-capable) for design and implementation.",
  "polish: strongest available for audit / bug-hunt.",
  "deepreep: strong for multi-source research; workers stay cheap for parallel fan-out.",
  "fallbacks: ordered spare after primary failure — capacity router may insert spares first.",
].join("\n");
