/**
 * Orchestrator: the engine entry. Builds provider candidates + tools, runs the
 * AI SDK v5 tool-calling loop via streamText (with no-tools + provider fallback
 * via openStream), bridges fullStream to our events, returns { text, parts }.
 *
 * Deferred: prepareStep compaction (Phase 4).
 */

import { streamText } from "ai";
import { join } from "node:path";
import type { RunKyreiChatOpts, RunKyreiChatResult, MessagePart } from "../types.js";
import { buildModel, buildProviderOptions } from "../provider/build.js";
import { resolveEngineConfig } from "../config/schema.js";
import { resolve as resolveModel } from "../provider/registry.js";
import { KeyPool } from "../provider/keys.js";
import { openStream, type StreamLike } from "../provider/open-stream.js";
import { buildTools, type ToolMeta } from "../tools/index.js";
import { buildWebTools } from "../tools/web.js";
import { isWorkspaceDir } from "../security/jail.js";
import { createCcrStore, makeRetrieveTool } from "../context/ccr.js";
import { assembleSystemContext } from "../memory/layers.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { buildStopWhen } from "./stop-conditions.js";
import { makePrepareStep } from "./prepare-step.js";
import { emitNoKeyGuidance } from "./no-key-guidance.js";
import { bridgeStream } from "../stream-bridge/bridge.js";
import { toParts } from "./persist.js";
import { createAuditLog } from "../security/audit.js";

export async function runKyreiChat(opts: RunKyreiChatOpts): Promise<RunKyreiChatResult> {
  const { config: cfg, warnings } = resolveEngineConfig(opts.config);
  if (warnings.length) console.warn("[kyrei v2] config:", warnings.join("; "));
  opts.emit({ type: "message.start" });

  if (opts.requiresApiKey !== false && !opts.apiKey) return emitNoKeyGuidance(opts.emit);

  const workspaceReady = Boolean(opts.workspace) && (await isWorkspaceDir(opts.workspace!));
  const toolMeta = new Map<string, ToolMeta>();
  const ccr = workspaceReady ? createCcrStore(join(opts.workspace!, ".kyrei", "ccr")) : null;
  let tools = workspaceReady ? buildTools(opts.workspace!, cfg, toolMeta, opts.abortSignal) : undefined;
  if (tools && ccr) tools = { ...tools, retrieve: makeRetrieveTool(ccr) };
  const webTools = buildWebTools(cfg, opts.auditLogPath ? { audit: createAuditLog(opts.auditLogPath) } : {});
  if (Object.keys(webTools).length) tools = { ...(tools ?? {}), ...webTools };

  let projectContext: string | undefined;
  if (workspaceReady) {
    try {
      const assembled = await assembleSystemContext({ workspace: opts.workspace! });
      projectContext = assembled.trim() ? assembled : undefined;
    } catch (error) {
      console.warn("[kyrei v2] project context disabled:", error);
    }
  }
  const system = buildSystemPrompt({
    workspace: opts.workspace,
    hasTools: Boolean(tools),
    personality: cfg.personality,
    projectContext,
  });

  // Candidate models: primary (from settings) + provider-local fallbacks.
  // A fallback must never move the active provider's API key or custom headers
  // to an unrelated endpoint. Until fallback credentials are stored per
  // provider, every candidate deliberately stays on the primary endpoint.
  const primary = resolveModel(opts.model, { baseURL: opts.providerBase, id: opts.model, provider: opts.providerId });
  const entries = [
    primary,
    ...cfg.fallbackChain.map((id) => resolveModel(id, { baseURL: primary.baseURL, provider: primary.provider })),
  ];
  const keyPool = new KeyPool({ keys: [opts.apiKey] });
  const prepareStep = ccr ? makePrepareStep(cfg, primary.id, primary.limits.contextWindow, ccr) : undefined;
  const providerOptions = buildProviderOptions(opts.modelParams);

  const start = (ci: number, useTools: boolean): StreamLike => {
    const entry = entries[ci] ?? primary;
    const model = buildModel({
      baseURL: entry.baseURL,
      apiKey: opts.apiKey,
      model: entry.id,
      headers: opts.providerHeaders,
      ...(keyPool.isMulti() ? { fetch: keyPool.fetchMiddleware() } : {}),
    });
    const result = streamText({
      model,
      ...(system ? { system } : {}),
      messages: opts.messages,
      ...(useTools && tools ? { tools, stopWhen: buildStopWhen(cfg) } : {}),
      ...(useTools && tools && prepareStep ? { prepareStep } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
      maxRetries: cfg.apiMaxRetries,
      onError: ({ error }: { error: unknown }) => {
        console.error("[kyrei v2] stream error:", error);
      },
    });
    return { fullStream: result.fullStream, response: result.response as Promise<{ messages: unknown[] }> };
  };

  const stream = await openStream(entries.length, Boolean(tools), start);

  const bridged = await bridgeStream(stream.fullStream, opts.emit, {
    toolMeta,
    provider: primary.provider,
    model: primary.id,
    maxSteps: cfg.maxSteps,
  });

  let parts: MessagePart[];
  try {
    const response = await stream.response;
    parts = toParts(response.messages as never, bridged);
  } catch {
    parts = bridged.parts;
  }

  return { text: bridged.text, parts };
}
