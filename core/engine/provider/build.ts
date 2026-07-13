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
}

export function buildModel(opts: BuildModelOpts): LanguageModel {
  const baseURL = opts.baseURL.replace(/\/+$/, "");
  const headers = { "X-Kyrei-Engine": "v2", ...(opts.headers ?? {}) };
  const credentials: ProviderCredentials = {
    ...(opts.credentials ?? {}),
    ...(!opts.credentials?.apiKey && opts.apiKey ? { apiKey: opts.apiKey } : {}),
  };

  switch (opts.protocol) {
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
  protocol: ProviderProtocol,
  params: ModelParams | undefined,
): Record<string, Record<string, string>> | undefined {
  if (!params) return undefined;

  const effort = resolveEffort(protocol, params);
  if (!effort) return undefined;

  switch (protocol) {
    case "openai-responses":
      return { [OPENAI_PROVIDER_OPTIONS_KEY]: { reasoningEffort: effort } };
    case "openai-chat":
      return { [OPENAI_COMPATIBLE_PROVIDER_NAME]: { reasoningEffort: effort } };
    default:
      return undefined;
  }
}

function resolveEffort(protocol: ProviderProtocol, params: ModelParams): string | undefined {
  const raw = (params.effort || "").trim().toLowerCase();
  if (raw && raw !== "off" && raw !== "none") {
    if (raw === "max") return protocol === "openai-responses" ? "xhigh" : "high";
    if (raw === "xhigh") return protocol === "openai-responses" ? "xhigh" : "high";
    return raw;
  }
  if (raw === "off" || raw === "none") return undefined;
  if (params.fast) return "minimal";
  if (params.reasoning) return "medium";
  return undefined;
}
