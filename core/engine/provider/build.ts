/**
 * Provider builder (Phase 1: minimal). Builds an explicit OpenAI-compatible
 * model object — NEVER a bare string (which would route through Vercel AI
 * Gateway). Registry / roles / fallback / key-pool land in Phase 3.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export interface BuildModelOpts {
  baseURL: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}

export function buildModel(opts: BuildModelOpts): LanguageModel {
  const provider = createOpenAICompatible({
    name: "kyrei",
    baseURL: opts.baseURL.replace(/\/+$/, ""),
    apiKey: opts.apiKey || "kyrei",
    includeUsage: true,
    headers: { "X-Kyrei-Engine": "v2" },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return provider(opts.model);
}
