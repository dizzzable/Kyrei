/**
 * OpenAI-compatible surface for Kyrei governance proxy (P3).
 *
 * Employees / external tools point at:
 *   base_url = http://127.0.0.1:<port>/v1
 *   api_key  = kyrei_at_...  (access token)
 *
 * This is NOT a full OpenAI clone — chat completions + models list only.
 * No tools, no vision multipart in v1 of the proxy (agent remains Kyrei-native).
 */

import { randomBytes } from "node:crypto";

/**
 * @typedef {object} OpenAiCompatProxyConfig
 * @property {boolean} enabled
 * @property {boolean} listenLan  bind 0.0.0.0 when true (requires access token)
 * @property {boolean} requireAccessToken  force AT even with gateway token
 */

/**
 * @param {unknown} raw
 * @returns {OpenAiCompatProxyConfig}
 */
export function normalizeProxyConfig(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    enabled: source.enabled !== false,
    listenLan: source.listenLan === true,
    requireAccessToken: source.requireAccessToken === true || source.listenLan === true,
  };
}

/**
 * List models visible to the OpenAI-compat catalog.
 * Ids are `providerId/modelId` plus bare modelId for the active model.
 * @param {{ providers?: Array<{ id: string, name?: string, enabled?: boolean, models?: Array<{ id: string, name?: string }> }>, activeProviderId?: string, activeModelId?: string }} config
 */
export function listCompatModels(config) {
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const models = [];
  const seen = new Set();
  for (const provider of providers) {
    if (!provider?.enabled) continue;
    for (const model of provider.models ?? []) {
      if (!model?.id) continue;
      const compound = `${provider.id}/${model.id}`;
      if (!seen.has(compound)) {
        seen.add(compound);
        models.push({
          id: compound,
          object: "model",
          created: 0,
          owned_by: provider.id,
          name: model.name || model.id,
          provider_name: provider.name || provider.id,
        });
      }
      // Active model also as bare id for simple clients
      if (provider.id === config.activeProviderId && model.id === config.activeModelId && !seen.has(model.id)) {
        seen.add(model.id);
        models.push({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: provider.id,
          name: model.name || model.id,
          provider_name: provider.name || provider.id,
        });
      }
    }
  }
  return { object: "list", data: models };
}

/**
 * Resolve body.model into { providerId, modelId }.
 * Accepts `provider/model` or bare model id (active provider preferred).
 */
export function resolveCompatModelRef(requested, config) {
  const raw = String(requested ?? "").trim();
  if (!raw) {
    return {
      providerId: config.activeProviderId,
      modelId: config.activeModelId,
    };
  }
  const slash = raw.indexOf("/");
  if (slash > 0) {
    return {
      providerId: raw.slice(0, slash),
      modelId: raw.slice(slash + 1),
    };
  }
  // Prefer active provider if it has the model
  const active = (config.providers ?? []).find((p) => p.id === config.activeProviderId);
  if (active?.models?.some((m) => m.id === raw)) {
    return { providerId: active.id, modelId: raw };
  }
  for (const provider of config.providers ?? []) {
    if (!provider.enabled) continue;
    if (provider.models?.some((m) => m.id === raw)) {
      return { providerId: provider.id, modelId: raw };
    }
  }
  return { providerId: config.activeProviderId, modelId: raw };
}

/**
 * Convert OpenAI chat messages to AI SDK ModelMessage[] (text only).
 * @param {unknown} messages
 */
export function openAiMessagesToModelMessages(messages) {
  if (!Array.isArray(messages)) return [];
  /** @type {Array<{ role: "system"|"user"|"assistant", content: string }>} */
  const out = [];
  for (const row of messages) {
    if (!row || typeof row !== "object") continue;
    const role = row.role === "system" || row.role === "assistant" || row.role === "user"
      ? row.role
      : row.role === "developer"
        ? "system"
        : null;
    if (!role) continue;
    const content = contentToText(row.content);
    if (!content && role !== "assistant") continue;
    out.push({ role, content });
  }
  return out;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

export function newCompletionId() {
  return `chatcmpl_${randomBytes(12).toString("hex")}`;
}

/**
 * @param {{ id: string, model: string, text: string, usage?: { inputTokens?: number, outputTokens?: number, totalTokens?: number }, finishReason?: string }} opts
 */
export function formatChatCompletionResponse(opts) {
  const input = Number(opts.usage?.inputTokens) || 0;
  const output = Number(opts.usage?.outputTokens) || 0;
  const total = Number(opts.usage?.totalTokens) || input + output;
  return {
    id: opts.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: opts.text ?? "",
      },
      finish_reason: opts.finishReason || "stop",
    }],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: total,
    },
  };
}

/**
 * First SSE chunk + content deltas + final stop for stream:true.
 * @param {{ id: string, model: string, text: string }} opts
 * @returns {string[]} SSE data lines (without trailing blank framing double-newlines pairs fully formed)
 */
export function formatChatCompletionSseFrames(opts) {
  const created = Math.floor(Date.now() / 1000);
  const base = {
    id: opts.id,
    object: "chat.completion.chunk",
    created,
    model: opts.model,
  };
  const frames = [];
  frames.push({
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });
  const text = String(opts.text ?? "");
  // Single content chunk is enough for correctness; clients accept multi or single.
  if (text) {
    frames.push({
      ...base,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    });
  }
  frames.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).concat(["data: [DONE]\n\n"]);
}

/**
 * Validate chat completion body shape (minimal).
 * @param {unknown} body
 * @returns {{ ok: true, messages: unknown[], model: string, stream: boolean } | { ok: false, error: string }}
 */
export function parseChatCompletionRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_request_body" };
  }
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: "messages_required" };
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";
  return {
    ok: true,
    messages,
    model,
    stream: body.stream === true,
  };
}
