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
import type {
  ModelParams,
  OpenAICompatibleReasoningTransport,
  ProviderCredentials,
  ProviderProtocol,
} from "../types.js";

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
  reasoningTransport?: OpenAICompatibleReasoningTransport,
  modelId?: string,
): ProviderOptionsMap | undefined {
  if (!params) return undefined;

  const effort = resolveEffortLevel(params);
  // Kimi K3 always reasons and documents `reasoning_effort: "max"` as its
  // supported request value. Keep that endpoint contract explicit instead of
  // coercing it through the generic OpenAI-compatible high/xhigh mapping.
  if (protocol === "openai-chat" && reasoningTransport === "kimi-k3-reasoning-max") {
    if (!effort && !isReasoningDisabled(params) && params.fast !== true) return undefined;
    return {
      [OPENAI_COMPATIBLE_PROVIDER_NAME]: {
        reasoningEffort: "max",
      },
    };
  }
  if (protocol === "openai-chat" && (
    reasoningTransport === "thinking-toggle"
    || reasoningTransport === "zai-thinking-preserved"
    || reasoningTransport === "kimi-thinking-preserved"
  )) {
    const disabled = isReasoningDisabled(params) || params.fast === true;
    if (!disabled && !effort) return undefined;
    const preserved: Record<string, JsonValue> = !disabled && reasoningTransport === "zai-thinking-preserved"
      ? { clear_thinking: false }
      : !disabled && reasoningTransport === "kimi-thinking-preserved"
        ? { keep: "all" }
        : {};
    const thinking: Record<string, JsonValue> = { type: disabled ? "disabled" : "enabled", ...preserved };
    return {
      [OPENAI_COMPATIBLE_PROVIDER_NAME]: {
        thinking,
      },
    };
  }
  if (!effort) return undefined;

  switch (protocol) {
    case "openai-responses":
      return {
        [OPENAI_PROVIDER_OPTIONS_KEY]: {
          reasoningEffort: mapOpenAiEffort(protocol, effort),
          // The official Responses API is the one OpenAI transport where the
          // latency intent has a documented, executable service tier. Custom
          // OpenAI-compatible gateways deliberately do not receive this
          // field: many reject it or interpret it differently.
          ...(params.fast === true ? { serviceTier: "priority" } : {}),
        },
      };
    case "openai-chat":
      return {
        [OPENAI_COMPATIBLE_PROVIDER_NAME]: {
          reasoningEffort: mapOpenAiEffort(protocol, effort),
        },
      };
    case "anthropic-messages": {
      // budgetTokens is REMOVED (hard 400) on Opus 4.7+, Sonnet 5, Fable 5 and
      // deprecated on the 4.6 family. Adaptive thinking + effort is the current
      // contract; only pre-4.6 models still take a token budget.
      if (anthropicThinkingDialect(modelId) === "budget") {
        return {
          [ANTHROPIC_PROVIDER_OPTIONS_KEY]: {
            thinking: { type: "enabled", budgetTokens: effortToAnthropicBudget(effort) },
          },
        };
      }
      return {
        [ANTHROPIC_PROVIDER_OPTIONS_KEY]: {
          // display defaults to "omitted" on current models, which streams
          // empty thinking blocks — keep the summary the UI already renders.
          thinking: { type: "adaptive", display: "summarized" },
          effort: effortToAnthropicEffort(effort, modelId),
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
      // Bedrock serves the same Anthropic models, so the budgetTokens removal
      // applies here too — it is only valid on the pre-4.6 families.
      const reasoningConfig: Record<string, JsonValue> = anthropicThinkingDialect(modelId) === "budget"
        ? {
          type: "enabled",
          // No `maxReasoningEffort` here, for the same reason the
          // anthropic-messages branch above omits `effort`: on the pre-4.6
          // families it is not merely ignored, it ERRORS (Sonnet 4.5, Haiku
          // 4.5). A token budget is the whole contract for those models.
          budgetTokens: effortToAnthropicBudget(effort),
        }
        : {
          type: "adaptive",
          maxReasoningEffort: effortToBedrockEffort(effort),
          display: "summarized",
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
export type ReasoningEffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Which Anthropic thinking contract a model id speaks.
 * - "budget": pre-4.6 families still require `thinking.budgetTokens` and reject
 *   `effort` on Sonnet 4.5 / Haiku 4.5, so we send neither adaptive nor effort.
 * - "adaptive-capped": the 4.6 family accepts adaptive + effort, but `xhigh`
 *   only arrived with Opus 4.7.
 * - "adaptive": 4.7+, Sonnet 5, Opus 5, Fable/Mythos 5, and anything newer.
 *
 * Unknown ids default to "adaptive": the legacy set is closed (no new Claude
 * at or below 4.5 will ship), so an unrecognized id is far more likely to be a
 * model released after this list than one predating it.
 */
function anthropicThinkingDialect(modelId?: string): "budget" | "adaptive-capped" | "adaptive" {
  // Locate the `claude-*` segment wherever it sits rather than stripping one
  // leading prefix: Bedrock cross-region inference profiles are
  // `us.anthropic.claude-…-v1:0` (two prefix segments — the standard form) and
  // Vertex uses a full `projects/…/models/claude-…` resource path. Stripping a
  // single segment left those unmatched, so every cross-region Bedrock user
  // was classified "adaptive" and sent the exact payload those models reject.
  const found = (modelId ?? "").trim().toLowerCase().match(/claude-[a-z0-9._-]+/);
  if (!found) return "adaptive";
  const id = found[0]
    .replace(/[@:][\w.-]*$/, "") // Vertex "@version", Bedrock ":0"
    .replace(/-v\d+$/, "") // Bedrock "-v1"
    .replace(/-\d{8}$/, ""); // dated snapshot
  if (/^claude-(?:opus|sonnet)-4-6$/.test(id)) return "adaptive-capped";
  if (/^claude-(?:instant|[0-3])\b/.test(id)) return "budget";
  if (/^claude-(?:opus|sonnet|haiku)-4(?:-(?:0|1|5))?$/.test(id)) return "budget";
  return "adaptive";
}

/** Anthropic `output_config.effort`; the enum has no "minimal". */
function effortToAnthropicEffort(
  effort: ReasoningEffortLevel,
  modelId?: string,
): "low" | "medium" | "high" | "xhigh" | "max" {
  const level = effort === "minimal" ? "low" : effort;
  if (level === "xhigh" && anthropicThinkingDialect(modelId) === "adaptive-capped") return "high";
  return level;
}

function resolveEffortLevel(params: ModelParams): ReasoningEffortLevel | undefined {
  const raw = (params.effort || "").trim().toLowerCase();
  if (raw === "off" || raw === "none") return undefined;
  if (raw === "minimal" || raw === "low" || raw === "medium" || raw === "high") return raw;
  if (raw === "xhigh") return "xhigh";
  if (raw === "max") return "max";
  if (raw) {
    // Unknown string: pass through only if it looks like a known level alias.
    if (raw === "min") return "minimal";
    return "medium";
  }
  if (params.fast) return "minimal";
  if (params.reasoning) return "medium";
  return undefined;
}

function isReasoningDisabled(params: ModelParams): boolean {
  const effort = (params.effort || "").trim().toLowerCase();
  return effort === "off" || effort === "none" || params.reasoning === false;
}

function mapOpenAiEffort(protocol: ProviderProtocol, effort: ReasoningEffortLevel): string {
  // OpenAI's ladder tops out at xhigh (Responses only); "max" is Anthropic-side
  // and must not leak through as a literal value here.
  if (effort === "xhigh" || effort === "max") return protocol === "openai-responses" ? "xhigh" : "high";
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
    case "max": return 32_000;
  }
}

function effortToGoogleLevel(effort: ReasoningEffortLevel): "minimal" | "low" | "medium" | "high" {
  if (effort === "xhigh" || effort === "max") return "high";
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
    case "max": return 24_576;
  }
}

function effortToBedrockEffort(effort: ReasoningEffortLevel): "low" | "medium" | "high" | "xhigh" | "max" {
  if (effort === "minimal") return "low";
  return effort;
}
