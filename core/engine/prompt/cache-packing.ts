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

import type { ModelMessage } from "ai";
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

/** Human-readable routing note for docs / settings (Wave B3 companion). */
export const ROLE_ROUTING_DEFAULTS = [
  "Main / session model: default strong model for chat turns.",
  "worker: cheap/fast for read-only subagents, clean-context review, and summary LLM pass.",
  "plan + build: strong models (reasoning-capable) for design and implementation.",
  "polish: strongest available for audit / bug-hunt.",
  "deepreep: strong for multi-source research; workers stay cheap for parallel fan-out.",
  "fallbacks: ordered spare after primary failure — capacity router may insert spares first.",
].join("\n");
