/**
 * Provider builder. Builds explicit built-in transport adapters — NEVER a bare
 * string (which would route through Vercel AI Gateway).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createGoogle } from "@ai-sdk/google";
import { createGoogleVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ModelParams, ProviderCredentials, ProviderProtocol } from "../types.js";

/** Provider slug used by the OpenAI-compatible builder and providerOptions. */
export const OPENAI_COMPATIBLE_PROVIDER_NAME = "kyrei";
export const OPENAI_PROVIDER_OPTIONS_KEY = "openai";
export const ANTHROPIC_PROVIDER_OPTIONS_KEY = "anthropic";

export interface BuildModelOpts {
  protocol: ProviderProtocol;
  baseURL: string;
  apiKey: string;
  credentials?: ProviderCredentials;
  model: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /**
   * When false (subscription shield stealth), omit the custom X-Kyrei-Engine
   * identity header so the client does not self-label as a non-browser tool.
   */
  identifyEngine?: boolean;
}

export function buildModel(opts: BuildModelOpts): LanguageModel {
  const baseURL = opts.baseURL.replace(/\/+$/, "");
  const headers = {
    ...(opts.identifyEngine === false ? {} : { "X-Kyrei-Engine": "v2" }),
    ...(opts.headers ?? {}),
  };
  const credentials: ProviderCredentials = {
    ...(opts.credentials ?? {}),
    ...(!opts.credentials?.apiKey && opts.apiKey ? { apiKey: opts.apiKey } : {}),
  };

  switch (opts.protocol) {
    case "codex-app-server":
      // ChatGPT/Codex is an agent runtime, not an OpenAI API credential. The
      // gateway owns its documented App Server bridge, so never accidentally
      // send a ChatGPT session to an HTTP-compatible provider adapter.
      throw new Error("codex_app_server_runtime_only");
    case "openai-responses": {
      const provider = createOpenAI({
        baseURL,
        ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}),
        headers,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      return provider.responses(opts.model);
    }
    case "anthropic-messages": {
      const provider = createAnthropic({
        baseURL,
        ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}),
        headers,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      return provider.messages(opts.model);
    }
    case "google-generative-ai": {
      const provider = createGoogle({
        baseURL,
        ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}),
        headers,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      return provider(opts.model);
    }
    case "amazon-bedrock": {
      // Standard Bedrock hosts are derived from the credential region so a
      // profile can move regions without leaving a stale public URL behind.
      const customBaseURL = /^https:\/\/bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/i.test(baseURL)
        ? undefined
        : baseURL;
      const provider = createAmazonBedrock({
        ...(credentials.region ? { region: credentials.region } : {}),
        ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}),
        ...(credentials.accessKeyId ? { accessKeyId: credentials.accessKeyId } : {}),
        ...(credentials.secretAccessKey ? { secretAccessKey: credentials.secretAccessKey } : {}),
        ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}),
        ...(customBaseURL ? { baseURL: customBaseURL } : {}),
        headers,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      return provider(opts.model);
    }
    case "google-vertex": {
      const customBaseURL = baseURL === "https://aiplatform.googleapis.com" ? undefined : baseURL;
      const serviceAccount = credentials.clientEmail && credentials.privateKey
        ? {
            credentials: {
              client_email: credentials.clientEmail,
              private_key: credentials.privateKey.replace(/\\n/g, "\n"),
              ...(credentials.project ? { project_id: credentials.project } : {}),
            },
          }
        : undefined;
      const provider = createGoogleVertex({
        ...(credentials.project ? { project: credentials.project } : {}),
        ...(credentials.location ? { location: credentials.location } : {}),
        ...(serviceAccount ? { googleAuthOptions: serviceAccount } : {}),
        ...(customBaseURL ? { baseURL: customBaseURL } : {}),
        headers,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      return provider(opts.model);
    }
    case "openai-chat":
    default: {
      const provider = createOpenAICompatible({
        name: OPENAI_COMPATIBLE_PROVIDER_NAME,
        baseURL,
        ...(credentials.apiKey ? { apiKey: credentials.apiKey } : {}),
        includeUsage: true,
        headers,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      return provider(opts.model);
    }
  }
}

export function hasProviderCredentials(protocol: ProviderProtocol, credentials: ProviderCredentials): boolean {
  switch (protocol) {
    case "amazon-bedrock":
      return Boolean(
        credentials.region &&
        (credentials.apiKey || (credentials.accessKeyId && credentials.secretAccessKey)),
      );
    case "google-vertex":
      return Boolean(
        credentials.project && credentials.location && credentials.clientEmail && credentials.privateKey,
      );
    default:
      return Boolean(credentials.apiKey);
  }
}

/** JSON-compatible value for AI SDK SharedV4ProviderOptions. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Nested providerOptions bag accepted by AI SDK streamText/generateText. */
export type ProviderOptionsMap = Record<string, { [key: string]: JsonValue }>;

export const GOOGLE_PROVIDER_OPTIONS_KEY = "google";
export const BEDROCK_PROVIDER_OPTIONS_KEY = "bedrock";

/**
 * Merge turn modelParams with engine defaultReasoningEffort when the turn did
 * not set an explicit effort (Hermes `agent.reasoning_effort` parity).
 */
export function resolveTurnModelParams(
  params: ModelParams | undefined,
  defaultReasoningEffort?: string,
): ModelParams | undefined {
  const base = params ?? {};
  const hasEffort = typeof base.effort === "string" && base.effort.trim().length > 0;
  const def = typeof defaultReasoningEffort === "string" ? defaultReasoningEffort.trim() : "";
  if (hasEffort || !def || def === "off" || def === "none") {
    if (!params && !base.fast && !base.reasoning) return params;
    return params ?? (base.fast || base.reasoning ? base : undefined);
  }
  return { ...base, effort: def };
}

/**
 * Translate UI model params into AI SDK `providerOptions` for every supported
 * protocol that can express thinking/reasoning:
 * - openai-responses / openai-chat → reasoningEffort
 * - anthropic-messages → thinking { type, budgetTokens }
 * - google-generative-ai / google-vertex → thinkingConfig
 * - amazon-bedrock → reasoningConfig
 *
 * Opt-in: when effort is off/unset, nothing is emitted (request unchanged).
 * Effort resolution: explicit effort wins; otherwise `fast` → minimal and
 * `reasoning` → medium.
 */
export function buildProviderOptions(
  protocol: ProviderProtocol,
  params: ModelParams | undefined,
): ProviderOptionsMap | undefined {
  if (!params) return undefined;

  const effort = resolveEffortLevel(params);
  if (!effort) return undefined;

  switch (protocol) {
    case "openai-responses":
      return {
        [OPENAI_PROVIDER_OPTIONS_KEY]: {
          reasoningEffort: mapOpenAiEffort(protocol, effort),
        },
      };
    case "openai-chat":
      return {
        [OPENAI_COMPATIBLE_PROVIDER_NAME]: {
          reasoningEffort: mapOpenAiEffort(protocol, effort),
        },
      };
    case "anthropic-messages": {
      // Extended thinking: budget-based enable. Adaptive exists on newer models
      // but budgetTokens remains the portable path across Claude 4.x.
      return {
        [ANTHROPIC_PROVIDER_OPTIONS_KEY]: {
          thinking: {
            type: "enabled",
            budgetTokens: effortToAnthropicBudget(effort),
          },
        },
      };
    }
    case "google-generative-ai": {
      // Gemini 3 uses thinkingLevel; Gemini 2.5 uses thinkingBudget — set both.
      const thinkingConfig = {
        thinkingLevel: effortToGoogleLevel(effort),
        thinkingBudget: effortToGoogleBudget(effort),
        includeThoughts: true,
      };
      return { [GOOGLE_PROVIDER_OPTIONS_KEY]: { thinkingConfig } };
    }
    case "google-vertex": {
      const thinkingConfig = {
        thinkingLevel: effortToGoogleLevel(effort),
        thinkingBudget: effortToGoogleBudget(effort),
        includeThoughts: true,
      };
      // Vertex accepts google / vertex / googleVertex option namespaces.
      return {
        google: { thinkingConfig },
        vertex: { thinkingConfig },
        googleVertex: { thinkingConfig },
      };
    }
    case "amazon-bedrock": {
      const reasoningConfig = {
        type: "enabled",
        maxReasoningEffort: effortToBedrockEffort(effort),
        budgetTokens: effortToAnthropicBudget(effort),
      };
      return {
        bedrock: { reasoningConfig },
        amazonBedrock: { reasoningConfig },
      };
    }
    default:
      return undefined;
  }
}

/** Canonical effort ladder used across providers. */
export type ReasoningEffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

function resolveEffortLevel(params: ModelParams): ReasoningEffortLevel | undefined {
  const raw = (params.effort || "").trim().toLowerCase();
  if (raw === "off" || raw === "none") return undefined;
  if (raw === "minimal" || raw === "low" || raw === "medium" || raw === "high") return raw;
  if (raw === "xhigh" || raw === "max") return "xhigh";
  if (raw) {
    // Unknown string: pass through only if it looks like a known level alias.
    if (raw === "min") return "minimal";
    return "medium";
  }
  if (params.fast) return "minimal";
  if (params.reasoning) return "medium";
  return undefined;
}

function mapOpenAiEffort(protocol: ProviderProtocol, effort: ReasoningEffortLevel): string {
  if (effort === "xhigh") return protocol === "openai-responses" ? "xhigh" : "high";
  return effort;
}

/** Anthropic budget_tokens — min 1024 on most extended-thinking models. */
function effortToAnthropicBudget(effort: ReasoningEffortLevel): number {
  switch (effort) {
    case "minimal": return 1_024;
    case "low": return 2_048;
    case "medium": return 8_000;
    case "high": return 16_000;
    case "xhigh": return 32_000;
  }
}

function effortToGoogleLevel(effort: ReasoningEffortLevel): "minimal" | "low" | "medium" | "high" {
  if (effort === "xhigh") return "high";
  return effort;
}

/** Gemini 2.5 thinkingBudget guidance (0 disables; we never emit when off). */
function effortToGoogleBudget(effort: ReasoningEffortLevel): number {
  switch (effort) {
    case "minimal": return 512;
    case "low": return 1_024;
    case "medium": return 4_096;
    case "high": return 8_192;
    case "xhigh": return 16_384;
  }
}

function effortToBedrockEffort(effort: ReasoningEffortLevel): "low" | "medium" | "high" | "xhigh" | "max" {
  if (effort === "minimal") return "low";
  if (effort === "xhigh") return "xhigh";
  return effort;
}
