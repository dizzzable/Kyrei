/**
 * Provider builder (Phase 1: minimal). Builds an explicit OpenAI-compatible
 * model object — NEVER a bare string (which would route through Vercel AI
 * Gateway). Registry / roles / fallback / key-pool land in Phase 3.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ModelParams } from "../types.js";

/** Provider slug used both to build the model and to key `providerOptions`. */
export const PROVIDER_NAME = "kyrei";

export interface BuildModelOpts {
  baseURL: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

export function buildModel(opts: BuildModelOpts): LanguageModel {
  const provider = createOpenAICompatible({
    name: PROVIDER_NAME,
    baseURL: opts.baseURL.replace(/\/+$/, ""),
    apiKey: opts.apiKey || "kyrei",
    includeUsage: true,
    headers: { "X-Kyrei-Engine": "v2" },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return provider(opts.model);
}

/**
 * Translate UI model params into AI SDK `providerOptions`. The openai-compatible
 * provider maps `reasoningEffort` → `reasoning_effort` in the request body and
 * passes any non-standard keys through verbatim, so this is a safe, opt-in knob:
 * when nothing is set we emit no fields and the request is unchanged.
 *
 * Effort resolution: an explicit effort wins; otherwise `fast` implies minimal
 * and `reasoning` implies medium. "off"/unset disables reasoning entirely.
 */
export function buildProviderOptions(
  params: ModelParams | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!params) return undefined;

  const effort = resolveEffort(params);
  if (!effort) return undefined;

  return { [PROVIDER_NAME]: { reasoningEffort: effort } };
}

function resolveEffort(params: ModelParams): string | undefined {
  const raw = (params.effort || "").trim().toLowerCase();
  if (raw && raw !== "off" && raw !== "none") {
    // "xhigh"/"max" are UI-only labels; clamp to the standard "high".
    return raw === "xhigh" || raw === "max" ? "high" : raw;
  }
  if (raw === "off" || raw === "none") return undefined;
  if (params.fast) return "minimal";
  if (params.reasoning) return "medium";
  return undefined;
}
