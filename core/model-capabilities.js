const MODALITIES = Object.freeze(["text", "image", "audio", "video", "file"]);
const MODALITY_SET = new Set(MODALITIES);
const FIELD_NAMES = Object.freeze([
  "contextWindow",
  "maxOutput",
  "inputModalities",
  "outputModalities",
  "tools",
  "reasoning",
  "streaming",
]);
const FIELD_SET = new Set(FIELD_NAMES);
const SOURCES = new Set(["live-provider", "curated", "mixed", "user-override", "unknown"]);
const CONFIDENCE = new Set(["high", "medium", "low", "unknown"]);
const MAX_CONTEXT_WINDOW = 100_000_000;
const MAX_OUTPUT_TOKENS = 10_000_000;

const OFFICIAL = Object.freeze({
  openaiGpt4oMini: "https://developers.openai.com/api/docs/models/gpt-4o-mini",
  openaiModels: "https://developers.openai.com/api/docs/models",
  anthropicModels: "https://platform.claude.com/docs/en/about-claude/models/overview",
  gemini25Pro: "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro",
  deepseekPricing: "https://api-docs.deepseek.com/quick_start/pricing-details-usd/",
});

function field(source, confidence, reference) {
  return { source, confidence, ...(reference ? { reference } : {}) };
}

function curatedEntry({ limits, modalities, features, reference }) {
  const fields = {};
  if (limits?.contextWindow !== undefined) fields.contextWindow = field("curated", "high", reference);
  if (limits?.maxOutput !== undefined) fields.maxOutput = field("curated", "high", reference);
  if (modalities?.input?.length) fields.inputModalities = field("curated", "high", reference);
  if (modalities?.output?.length) fields.outputModalities = field("curated", "high", reference);
  for (const name of ["tools", "reasoning", "streaming"]) {
    if (features?.[name] !== undefined) fields[name] = field("curated", "high", reference);
  }
  return {
    ...(limits ? { limits } : {}),
    ...(modalities ? { modalities } : {}),
    ...(features ? { features } : {}),
    provenance: { source: "curated", confidence: "high", fields },
  };
}

/**
 * Small exact-match registry. It deliberately contains no prefix/substring
 * matching: aliases and snapshots are separate keys so an unfamiliar model
 * never inherits a plausible-looking but false context window.
 */
const CURATED = new Map();

function addCurated(provider, ids, metadata) {
  for (const id of ids) CURATED.set(`${provider}::${id}`, metadata);
}

addCurated("openai", ["gpt-4o-mini", "gpt-4o-mini-2024-07-18"], curatedEntry({
  limits: { contextWindow: 128_000, maxOutput: 16_384 },
  modalities: { input: ["text", "image"], output: ["text"] },
  features: { tools: true, reasoning: false, streaming: true },
  reference: OFFICIAL.openaiGpt4oMini,
}));

addCurated("openai", ["gpt-5.6-sol", "gpt-5.6"], curatedEntry({
  limits: { contextWindow: 1_050_000, maxOutput: 128_000 },
  modalities: { input: ["text", "image"], output: ["text"] },
  features: { tools: true, reasoning: true, streaming: true },
  reference: OFFICIAL.openaiModels,
}));

addCurated("anthropic", ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"], curatedEntry({
  limits: { contextWindow: 200_000, maxOutput: 64_000 },
  modalities: { input: ["text", "image"], output: ["text"] },
  features: { tools: true, reasoning: true, streaming: true },
  reference: OFFICIAL.anthropicModels,
}));

addCurated("google", ["gemini-2.5-pro"], curatedEntry({
  limits: { contextWindow: 1_048_576, maxOutput: 65_536 },
  modalities: { input: ["text", "image", "audio", "video"], output: ["text"] },
  features: { tools: true, reasoning: true, streaming: true },
  reference: OFFICIAL.gemini25Pro,
}));

addCurated("deepseek", ["deepseek-chat"], curatedEntry({
  limits: { contextWindow: 64_000, maxOutput: 8_000 },
  modalities: { input: ["text"], output: ["text"] },
  features: { tools: true, reasoning: false, streaming: true },
  reference: OFFICIAL.deepseekPricing,
}));

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function valueAt(source, path) {
  let current = source;
  for (const segment of path) {
    current = object(current)[segment];
    if (current === undefined || current === null) return undefined;
  }
  return current;
}

function boundedInteger(value, max) {
  if (typeof value === "string" && !/^\d{1,12}$/.test(value.trim())) return undefined;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric > max) return undefined;
  return numeric;
}

function firstInteger(source, paths, max) {
  for (const path of paths) {
    const value = boundedInteger(valueAt(source, path), max);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstBoolean(source, paths) {
  for (const path of paths) {
    const value = valueAt(source, path);
    if (typeof value === "boolean") return value;
    if (object(value).supported !== undefined && typeof object(value).supported === "boolean") {
      return object(value).supported;
    }
  }
  return undefined;
}

function normalizeModalities(value) {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values)) return undefined;
  const seen = new Set();
  const result = [];
  for (const raw of values) {
    const modality = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!MODALITY_SET.has(modality) || seen.has(modality)) continue;
    seen.add(modality);
    result.push(modality);
  }
  return result.length ? result : undefined;
}

function firstModalities(source, paths) {
  for (const path of paths) {
    const value = normalizeModalities(valueAt(source, path));
    if (value) return value;
  }
  return undefined;
}

function supportedStringSet(value) {
  const rows = Array.isArray(value) ? value : [];
  return new Set(rows.filter((value) => typeof value === "string").map((value) => value.trim().toLowerCase()));
}

function supportedParameterSet(source) {
  return supportedStringSet(source.supported_parameters);
}

function hasAnyMetadata(value) {
  return Boolean(
    value?.limits?.contextWindow !== undefined
    || value?.limits?.maxOutput !== undefined
    || value?.modalities?.input?.length
    || value?.modalities?.output?.length
    || value?.features?.tools !== undefined
    || value?.features?.reasoning !== undefined
    || value?.features?.streaming !== undefined
  );
}

/** Extract only explicitly represented fields from a live provider row. */
export function extractLiveModelCapabilities(value, { retrievedAt } = {}) {
  const source = object(value);
  const contextWindow = firstInteger(source, [
    ["context_window"], ["contextWindow"], ["context_length"], ["contextLength"],
    ["max_context_length"], ["maxContextLength"], ["max_input_tokens"], ["inputTokenLimit"],
    ["limits", "contextWindow"], ["limits", "context_window"], ["limits", "max_input_tokens"],
    ["top_provider", "context_length"],
  ], MAX_CONTEXT_WINDOW);
  const maxOutput = firstInteger(source, [
    ["max_output_tokens"], ["maxOutputTokens"], ["max_tokens"], ["outputTokenLimit"],
    ["limits", "maxOutput"], ["limits", "max_output"], ["top_provider", "max_completion_tokens"],
  ], MAX_OUTPUT_TOKENS);
  const explicitInput = firstModalities(source, [
    ["input_modalities"], ["inputModalities"], ["architecture", "input_modalities"],
    ["modalities", "input"], ["capabilities", "input_modalities"],
  ]);
  const output = firstModalities(source, [
    ["output_modalities"], ["outputModalities"], ["architecture", "output_modalities"],
    ["modalities", "output"], ["capabilities", "output_modalities"],
    ["primary_output_modality"], ["capabilities", "primary_output_modality"],
  ]);
  const parameters = supportedParameterSet(source);
  const methods = supportedStringSet(source.supportedGenerationMethods);
  const imageInput = firstBoolean(source, [
    ["capabilities", "image_input"], ["capabilities", "imageInput"],
  ]);
  // Anthropic's catalog exposes image input as a dedicated capability rather
  // than a modality list. A positive value is explicit evidence for both the
  // normal text input and image blocks; a false/missing value is not used to
  // infer text-only support for arbitrary compatible providers.
  const input = explicitInput ?? (imageInput === true ? ["text", "image"] : undefined);
  const explicitTools = firstBoolean(source, [
    ["supports_tools"], ["supportsTools"], ["tool_use"], ["capabilities", "tools"],
    ["capabilities", "supports_tools"], ["capabilities", "tool_use"], ["capabilities", "function_calling"],
  ]);
  const explicitReasoning = firstBoolean(source, [
    ["supports_reasoning"], ["supportsReasoning"], ["reasoning"], ["thinking"],
    ["capabilities", "supports_reasoning"], ["capabilities", "reasoning"],
    ["capabilities", "thinking"], ["capabilities", "effort"],
  ]);
  const explicitStreaming = firstBoolean(source, [
    ["supports_streaming"], ["supportsStreaming"], ["streaming"], ["capabilities", "streaming"],
    ["supports_stream"], ["capabilities", "supports_stream"],
  ]);
  const tools = explicitTools ?? (parameters.has("tools") || parameters.has("tool_choice") ? true : undefined);
  const reasoning = explicitReasoning ?? (
    parameters.has("reasoning") || parameters.has("reasoning_effort") || parameters.has("include_reasoning")
      ? true
      : undefined
  );
  // Gemini's official catalog reports supported methods. Only an explicit
  // streaming method proves this capability; its absence remains unknown.
  const streaming = explicitStreaming ?? (methods.has("streamgeneratecontent") ? true : undefined);
  const fields = {};
  if (contextWindow !== undefined) fields.contextWindow = field("live-provider", "high");
  if (maxOutput !== undefined) fields.maxOutput = field("live-provider", "high");
  if (input) fields.inputModalities = field("live-provider", "high");
  if (output) fields.outputModalities = field("live-provider", "high");
  if (tools !== undefined) fields.tools = field("live-provider", explicitTools === undefined ? "medium" : "high");
  if (reasoning !== undefined) fields.reasoning = field("live-provider", explicitReasoning === undefined ? "medium" : "high");
  if (streaming !== undefined) fields.streaming = field("live-provider", "high");
  const result = {
    ...((contextWindow !== undefined || maxOutput !== undefined) ? {
      limits: {
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutput !== undefined ? { maxOutput } : {}),
      },
    } : {}),
    ...((input || output) ? { modalities: { ...(input ? { input } : {}), ...(output ? { output } : {}) } } : {}),
    ...((tools !== undefined || reasoning !== undefined || streaming !== undefined) ? {
      features: {
        ...(tools !== undefined ? { tools } : {}),
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(streaming !== undefined ? { streaming } : {}),
      },
    } : {}),
    provenance: {
      source: "live-provider",
      confidence: Object.values(fields).some((entry) => entry.confidence === "medium") ? "medium" : "high",
      ...(Number.isSafeInteger(retrievedAt) && retrievedAt > 0 ? { retrievedAt } : {}),
      fields,
    },
  };
  return hasAnyMetadata(result) ? result : undefined;
}

function canonicalProvider(providerId, baseURL) {
  const id = String(providerId ?? "").trim().toLowerCase();
  let host = "";
  try { host = new URL(String(baseURL ?? "")).hostname.toLowerCase(); } catch { /* unknown */ }
  if (host === "api.openai.com") return "openai";
  if (host === "api.anthropic.com") return "anthropic";
  if (host === "generativelanguage.googleapis.com") return "google";
  if (host === "api.deepseek.com") return "deepseek";
  // A configured non-official endpoint is a proxy/custom provider even when
  // its user-defined id resembles a first-party provider. Do not attach facts
  // from a different service to it without live metadata.
  if (host) return "";
  if (["openai", "anthropic", "google", "gemini", "deepseek"].includes(id)) return id === "gemini" ? "google" : id;
  return "";
}

export function curatedModelCapabilities({ providerId, baseURL, modelId } = {}) {
  const id = typeof modelId === "string" ? modelId.trim() : "";
  if (!id) return undefined;
  const provider = canonicalProvider(providerId, baseURL);
  return provider ? clone(CURATED.get(`${provider}::${id}`)) : undefined;
}

function fieldValue(metadata, name) {
  if (name === "contextWindow" || name === "maxOutput") return metadata?.limits?.[name];
  if (name === "inputModalities") return metadata?.modalities?.input;
  if (name === "outputModalities") return metadata?.modalities?.output;
  return metadata?.features?.[name];
}

function assignField(target, name, value) {
  if (value === undefined) return;
  if (name === "contextWindow" || name === "maxOutput") {
    target.limits ??= {};
    target.limits[name] = clone(value);
  } else if (name === "inputModalities" || name === "outputModalities") {
    target.modalities ??= {};
    target.modalities[name === "inputModalities" ? "input" : "output"] = clone(value);
  } else {
    target.features ??= {};
    target.features[name] = value;
  }
}

/** Live metadata wins field-by-field; exact curated data fills only omissions. */
export function resolveModelCapabilities({ providerId, baseURL, modelId, live } = {}) {
  const curated = curatedModelCapabilities({ providerId, baseURL, modelId });
  const liveSafe = normalizeStoredModelCapabilities(live);
  const result = {};
  const fields = {};
  const sources = new Set();
  for (const name of FIELD_NAMES) {
    const primary = fieldValue(liveSafe, name);
    const fallback = fieldValue(curated, name);
    const value = primary !== undefined ? primary : fallback;
    if (value === undefined) continue;
    assignField(result, name, value);
    const provenance = primary !== undefined
      ? liveSafe?.provenance?.fields?.[name] ?? field("live-provider", "high")
      : curated?.provenance?.fields?.[name] ?? field("curated", "high");
    fields[name] = provenance;
    sources.add(provenance.source);
  }
  if (!Object.keys(fields).length) {
    return { provenance: { source: "unknown", confidence: "unknown", fields: {} } };
  }
  const confidenceValues = Object.values(fields).map((entry) => entry.confidence);
  result.provenance = {
    source: sources.size === 1 ? [...sources][0] : "mixed",
    confidence: confidenceValues.includes("low")
      ? "low"
      : confidenceValues.includes("medium")
        ? "medium"
        : "high",
    ...(liveSafe?.provenance?.retrievedAt ? { retrievedAt: liveSafe.provenance.retrievedAt } : {}),
    fields,
  };
  return result;
}

function normalizeProvenance(value, presentFields) {
  const source = object(value);
  const declaredSource = SOURCES.has(source.source) ? source.source : "unknown";
  const declaredConfidence = CONFIDENCE.has(source.confidence) ? source.confidence : "unknown";
  const fields = {};
  for (const name of presentFields) {
    const entry = object(object(source.fields)[name]);
    const entrySource = SOURCES.has(entry.source) ? entry.source : declaredSource;
    const confidence = CONFIDENCE.has(entry.confidence) ? entry.confidence : declaredConfidence;
    const reference = entrySource === "curated" && typeof entry.reference === "string" && Object.values(OFFICIAL).includes(entry.reference)
      ? entry.reference
      : undefined;
    fields[name] = { source: entrySource, confidence, ...(reference ? { reference } : {}) };
  }
  const retrievedAt = Number.isSafeInteger(source.retrievedAt) && source.retrievedAt > 0 ? source.retrievedAt : undefined;
  return { source: declaredSource, confidence: declaredConfidence, ...(retrievedAt ? { retrievedAt } : {}), fields };
}

/** Strict public-config sanitizer for metadata persisted beside a model id. */
export function normalizeStoredModelCapabilities(value) {
  const source = object(value);
  const contextWindow = boundedInteger(object(source.limits).contextWindow, MAX_CONTEXT_WINDOW);
  const maxOutput = boundedInteger(object(source.limits).maxOutput, MAX_OUTPUT_TOKENS);
  const input = normalizeModalities(object(source.modalities).input);
  const output = normalizeModalities(object(source.modalities).output);
  const featuresSource = object(source.features);
  const features = {};
  for (const name of ["tools", "reasoning", "streaming"]) {
    if (typeof featuresSource[name] === "boolean") features[name] = featuresSource[name];
  }
  const presentFields = [];
  if (contextWindow !== undefined) presentFields.push("contextWindow");
  if (maxOutput !== undefined) presentFields.push("maxOutput");
  if (input) presentFields.push("inputModalities");
  if (output) presentFields.push("outputModalities");
  for (const name of Object.keys(features)) if (FIELD_SET.has(name)) presentFields.push(name);
  if (!presentFields.length) return undefined;
  return {
    ...((contextWindow !== undefined || maxOutput !== undefined) ? {
      limits: {
        ...(contextWindow !== undefined ? { contextWindow } : {}),
        ...(maxOutput !== undefined ? { maxOutput } : {}),
      },
    } : {}),
    ...((input || output) ? { modalities: { ...(input ? { input } : {}), ...(output ? { output } : {}) } } : {}),
    ...(Object.keys(features).length ? { features } : {}),
    provenance: normalizeProvenance(source.provenance, presentFields),
  };
}

export const MODEL_CAPABILITY_MODALITIES = MODALITIES;
export const MODEL_CAPABILITY_OFFICIAL_SOURCES = OFFICIAL;
