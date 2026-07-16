/**
 * Versioned provider-registry configuration used by the local gateway.
 *
 * Provider metadata is safe to return to the renderer; credentials live in a
 * separate secret file managed by the gateway. The registry dispatches only
 * audited built-in transports and never loads executable provider code from
 * user configuration.
 */

import { normalizeOrchestration } from "./team-config.js";
import { normalizePipelines } from "./pipeline-config.js";
import {
  PROVIDER_ACCOUNT_POOL_STRATEGIES,
  normalizeProviderAccountMember,
  normalizeProviderAccountPool as normalizeAccountPoolMetadata,
} from "./provider-account-pool.js";
import {
  normalizeKiroOrganizationConfig,
  normalizeKiroOrganizationSecrets,
  serializeKiroOrganizationSecrets,
} from "./kiro-organization-config.js";
import {
  normalizeStoredModelCapabilities,
  resolveModelCapabilities,
} from "./model-capabilities.js";

export { PROVIDER_ACCOUNT_POOL_STRATEGIES };

export const SUPPORTED_PROVIDER_PROTOCOLS = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "amazon-bedrock",
  "google-vertex",
];
const DEFAULT_PROVIDER_ID = "default-openai-compatible";
const DEFAULT_PROTOCOL = "openai-chat";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_PROVIDER_NAME = 120;
const MAX_PROVIDER_MODELS = 2_000;
const MAX_MODEL_ID = 512;
const MAX_MODEL_NAME = 512;
const MAX_MODEL_FALLBACKS = 16;
const MAX_PROVIDER_ACCOUNTS = 64;
const MAX_PROVIDER_ACCOUNT_NAME = 120;
const PROVIDER_ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEFAULT_BASE_URLS = {
  "openai-chat": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com/v1",
  "google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
  "amazon-bedrock": "https://bedrock-runtime.us-east-1.amazonaws.com",
  "google-vertex": "https://aiplatform.googleapis.com",
};

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeId(value, fallback) {
  const candidate = text(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return candidate && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate) ? candidate : fallback;
}

export function normalizeProviderAccountId(value, fallback = "account") {
  return normalizeId(value, fallback);
}

function providerModelIdSet(providerModels) {
  if (!Array.isArray(providerModels)) return null;
  return new Set(providerModels.flatMap((row) => {
    const source = typeof row === "string" ? { id: row } : object(row);
    const id = text(source.id);
    return id ? [id] : [];
  }));
}

function validateProviderAccountModelIds(source, providerModels) {
  if (!Object.hasOwn(source, "modelIds")) return undefined;
  // PATCH clients need an explicit way to remove a restriction while an
  // omitted field continues to mean "leave unchanged". Persist the result as
  // an absent property, which is the canonical unrestricted representation.
  if (source.modelIds === null) return null;
  if (!Array.isArray(source.modelIds) || source.modelIds.length > MAX_PROVIDER_MODELS) {
    throw new ProviderConfigError("provider_account_models_invalid");
  }
  const known = providerModelIdSet(providerModels);
  const seen = new Set();
  const modelIds = [];
  for (const row of source.modelIds) {
    const modelId = typeof row === "string" ? row.trim() : "";
    if (
      !modelId
      || modelId.length > MAX_MODEL_ID
      || /[\u0000-\u001f\u007f]/.test(modelId)
      || (known && !known.has(modelId))
    ) throw new ProviderConfigError("provider_account_models_invalid");
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}

/** Ensure every provider has one immutable primary member for legacy credentials. */
export function normalizeProviderAccountPool(value, providerModels) {
  const source = object(value);
  const rows = Array.isArray(source.members)
    ? source.members
    : Array.isArray(source.accounts)
      ? source.accounts
      : [];
  const primarySource = rows.find((row) => object(row).id === "primary") ?? { id: "primary", name: "Primary" };
  const primary = normalizeProviderAccountMember({ ...object(primarySource), id: "primary" }, "primary", 0);
  const members = [{ ...primary, id: "primary", priority: 0 }];
  const seen = new Set(["primary"]);
  for (let index = 0; index < rows.length && members.length < MAX_PROVIDER_ACCOUNTS; index += 1) {
    if (object(rows[index]).id === "primary") continue;
    const member = normalizeProviderAccountMember(rows[index], `account-${members.length + 1}`, members.length * 100);
    if (seen.has(member.id)) continue;
    seen.add(member.id);
    members.push(member);
  }
  const normalized = normalizeAccountPoolMetadata({ ...source, members });
  const knownModelIds = providerModelIdSet(providerModels);
  return {
    ...normalized,
    enabled: normalized.enabled && normalized.members.length > 1,
    members: normalized.members.map((member) => ({
      id: member.id,
      name: member.name,
      enabled: member.enabled,
      weight: member.weight,
      priority: member.priority,
      maxConcurrency: Number.isInteger(object(rows.find((row) => object(row).id === member.id)).maxConcurrency)
        ? Math.min(64, Math.max(1, object(rows.find((row) => object(row).id === member.id)).maxConcurrency))
        : 4,
      ...(Object.hasOwn(member, "modelIds")
        ? { modelIds: knownModelIds ? member.modelIds.filter((modelId) => knownModelIds.has(modelId)) : [...member.modelIds] }
        : {}),
    })),
  };
}

export function validateProviderAccountInput(value, { accountId, providerModels, allowPrimary = false } = {}) {
  const source = object(value);
  const id = typeof (accountId ?? source.id) === "string" ? (accountId ?? source.id).trim().toLowerCase() : "";
  if (!PROVIDER_ACCOUNT_ID.test(id) || (id === "primary" && !allowPrimary)) {
    throw new ProviderConfigError("provider_account_id_invalid");
  }
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name || name.length > MAX_PROVIDER_ACCOUNT_NAME) {
    throw new ProviderConfigError("provider_account_name_invalid");
  }
  const integer = (field, fallback, min, max) => {
    if (source[field] === undefined) return fallback;
    if (!Number.isInteger(source[field]) || source[field] < min || source[field] > max) {
      throw new ProviderConfigError("provider_account_limits_invalid");
    }
    return source[field];
  };
  const modelIds = validateProviderAccountModelIds(source, providerModels);
  return {
    id,
    name,
    enabled: source.enabled !== false,
    weight: integer("weight", 1, 1, 100),
    priority: integer("priority", 100, 0, 10_000),
    maxConcurrency: integer("maxConcurrency", 4, 1, 64),
    ...(Array.isArray(modelIds) ? { modelIds } : {}),
  };
}

export function validateProviderPoolInput(value, currentPool) {
  const source = object(value);
  if (source.strategy !== undefined && !PROVIDER_ACCOUNT_POOL_STRATEGIES.includes(source.strategy)) {
    throw new ProviderConfigError("provider_pool_strategy_invalid");
  }
  const current = normalizeProviderAccountPool(currentPool);
  return normalizeProviderAccountPool({
    ...current,
    ...(source.enabled !== undefined ? { enabled: source.enabled === true } : {}),
    ...(source.strategy !== undefined ? { strategy: source.strategy } : {}),
    ...(source.sessionAffinity !== undefined ? { sessionAffinity: source.sessionAffinity !== false } : {}),
  });
}

export function createProviderAccountId(name, members = []) {
  const base = normalizeProviderAccountId(name, "account");
  const known = new Set(members.map((member) => member.id));
  if (base !== "primary" && !known.has(base)) return base;
  let suffix = 2;
  while (known.has(`${base.slice(0, 56)}-${suffix}`)) suffix += 1;
  return `${base.slice(0, 56)}-${suffix}`;
}

export function normalizeExplicitProviderId(value) {
  if (typeof value !== "string") throw new ProviderConfigError("provider_id_required");
  const candidate = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate)) {
    throw new ProviderConfigError("provider_id_invalid");
  }
  return candidate;
}

export function isLocalProviderUrl(baseURL) {
  try {
    const url = new URL(baseURL);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      host === "localhost"
      || host.endsWith(".localhost")
      || host === "0.0.0.0"
      || host === "::1"
      || host === "127.0.0.1"
    ) {
      return true;
    }
    // Any 127/8 loopback
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    // RFC1918 LAN (Ollama/LM Studio on another machine in the home network)
    const parts = host.split(".").map(Number);
    if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      const [a, b] = parts;
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
    }
    // Unique local IPv6 fc00::/7
    if (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd"))) return true;
    return false;
  } catch {
    return false;
  }
}

export function defaultBaseURLForProtocol(protocol) {
  return DEFAULT_BASE_URLS[protocol] ?? DEFAULT_BASE_URLS[DEFAULT_PROTOCOL];
}

export function normalizeProviderProtocol(value) {
  const candidate = text(value).toLowerCase();
  return SUPPORTED_PROVIDER_PROTOCOLS.includes(candidate) ? candidate : DEFAULT_PROTOCOL;
}

export function normalizeBaseURL(value, fallback = defaultBaseURLForProtocol(DEFAULT_PROTOCOL)) {
  const candidate = text(value, fallback).replace(/\/+$/, "");
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    // Keep credentials in the dedicated secret store. A URL with userinfo
    // would otherwise persist a secret in the public provider config.
    if (url.username || url.password || url.search || url.hash) return fallback;
    return url.href.replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

const LIVE_CAPABILITY_FIELDS = [
  "contextWindow",
  "maxOutput",
  "inputModalities",
  "outputModalities",
  "tools",
  "reasoning",
  "streaming",
];
const DISCOVERABLE_CAPABILITY_PROTOCOLS = new Set([
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

function capabilityFieldValue(metadata, name) {
  if (name === "contextWindow" || name === "maxOutput") return metadata?.limits?.[name];
  if (name === "inputModalities") return metadata?.modalities?.input;
  if (name === "outputModalities") return metadata?.modalities?.output;
  return metadata?.features?.[name];
}

function assignCapabilityField(target, name, value) {
  if (value === undefined) return;
  if (name === "contextWindow" || name === "maxOutput") {
    target.limits ??= {};
    target.limits[name] = value;
  } else if (name === "inputModalities" || name === "outputModalities") {
    target.modalities ??= {};
    target.modalities[name === "inputModalities" ? "input" : "output"] = [...value];
  } else {
    target.features ??= {};
    target.features[name] = value;
  }
}

function validatedLiveCapabilities(value, { protocol, baseURL, modelId }, verifyLiveCapabilities) {
  if (!DISCOVERABLE_CAPABILITY_PROTOCOLS.has(protocol)) return undefined;
  const raw = object(value);
  const rawOrigin = object(object(raw.provenance).origin);
  if (rawOrigin.protocol !== protocol || rawOrigin.modelId !== modelId) return undefined;
  let originBaseURL;
  try {
    originBaseURL = strictBaseURL(rawOrigin.baseURL);
  } catch {
    return undefined;
  }
  if (originBaseURL !== baseURL) return undefined;

  const normalized = normalizeStoredModelCapabilities(raw);
  if (!normalized) return undefined;
  const live = {};
  const fields = {};
  const confidences = [];
  for (const name of LIVE_CAPABILITY_FIELDS) {
    const provenance = normalized.provenance?.fields?.[name];
    if (provenance?.source !== "live-provider") continue;
    const value = capabilityFieldValue(normalized, name);
    if (value === undefined) continue;
    assignCapabilityField(live, name, value);
    fields[name] = provenance;
    confidences.push(provenance.confidence);
  }
  if (!Object.keys(fields).length) return undefined;
  if (typeof verifyLiveCapabilities === "function") {
    let verified = false;
    try {
      verified = verifyLiveCapabilities({
        capabilities: normalized,
        protocol,
        baseURL,
        modelId,
      }) === true;
    } catch {
      // Verification is a trust boundary. Cache failures and malformed hooks
      // fail closed, leaving only server-curated metadata eligible below.
    }
    if (!verified) return undefined;
  }
  live.provenance = {
    source: "live-provider",
    confidence: confidences.includes("low") ? "low" : confidences.includes("medium") ? "medium" : "high",
    ...(normalized.provenance.retrievedAt ? { retrievedAt: normalized.provenance.retrievedAt } : {}),
    fields,
  };
  return normalizeStoredModelCapabilities(live);
}

function modelCapabilities(source, { providerId, protocol, baseURL, modelId, verifyLiveCapabilities }) {
  const live = validatedLiveCapabilities(
    source.capabilities,
    { protocol, baseURL, modelId },
    verifyLiveCapabilities,
  );
  const capabilities = normalizeStoredModelCapabilities(resolveModelCapabilities({
    providerId,
    baseURL,
    modelId,
    live,
  }));
  if (!capabilities || !live) return capabilities;
  return {
    ...capabilities,
    provenance: {
      ...capabilities.provenance,
      origin: { protocol, baseURL, modelId },
    },
  };
}

function normalizeModels(value, fallbackModel, providerContext) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const models = [];
  for (const row of rows.slice(0, MAX_PROVIDER_MODELS)) {
    const source = typeof row === "string" ? { id: row } : object(row);
    const id = text(source.id);
    if (!id || id.length > MAX_MODEL_ID || /[\u0000-\u001f\u007f]/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = text(source.name).slice(0, MAX_MODEL_NAME);
    const capabilities = modelCapabilities(source, { ...providerContext, modelId: id });
    models.push({ id, ...(name ? { name } : {}), ...(capabilities ? { capabilities } : {}) });
  }
  if (!models.length) {
    const id = text(fallbackModel, DEFAULT_MODEL);
    const capabilities = modelCapabilities({}, { ...providerContext, modelId: id });
    models.push({ id, ...(capabilities ? { capabilities } : {}) });
  }
  return models;
}

function validateModels(value, providerContext) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProviderConfigError("provider_models_required");
  }
  const seen = new Set();
  const models = [];
  for (const row of value.slice(0, MAX_PROVIDER_MODELS)) {
    const source = typeof row === "string" ? { id: row } : object(row);
    const id = typeof source.id === "string" ? source.id.trim() : "";
    if (!id || id.length > MAX_MODEL_ID || /[\u0000-\u001f\u007f]/.test(id)) throw new ProviderConfigError("provider_model_invalid");
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (name.length > MAX_MODEL_NAME) throw new ProviderConfigError("provider_model_invalid");
    const capabilities = modelCapabilities(source, { ...providerContext, modelId: id });
    models.push({ id, ...(name ? { name } : {}), ...(capabilities ? { capabilities } : {}) });
  }
  if (!models.length) throw new ProviderConfigError("provider_models_required");
  return models;
}

const SECRET_HEADER_NAME = /(?:auth(?:entication|orization)?|token|secret|api[-_]?key|credential|cookie|password|signature)/i;
const SECRET_HEADER_VALUE = /(?:^|\s)Bearer\s+|^sk[-_]|^eyJ[A-Za-z0-9_-]{10,}\./i;
const PROVIDER_CREDENTIAL_VALUE_FIELDS = [
  "apiKey",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
  "privateKey",
  "clientEmail",
];

function normalizeHeaders(value, { strict = false } = {}) {
  const headers = {};
  for (const [key, raw] of Object.entries(object(value))) {
    // The registry is returned to the renderer, so it must never carry a
    // credential-bearing header. API keys use the separate secrets endpoint.
    const invalid = !/^[A-Za-z0-9-]{1,100}$/.test(key)
      || SECRET_HEADER_NAME.test(key)
      || typeof raw !== "string"
      || raw.length > 2000
      || SECRET_HEADER_VALUE.test(raw);
    if (invalid) {
      if (strict) throw new ProviderConfigError("provider_header_secret_forbidden");
      continue;
    }
    headers[key] = raw;
  }
  return headers;
}

export function normalizeProvider(value, fallbackId = DEFAULT_PROVIDER_ID) {
  const source = object(value);
  const id = normalizeId(source.id, fallbackId);
  const protocol = normalizeProviderProtocol(source.protocol);
  const baseURL = normalizeBaseURL(source.baseURL ?? source.provider, defaultBaseURLForProtocol(protocol));
  const headers = normalizeHeaders(source.headers);
  const models = normalizeModels(source.models, source.model, { providerId: id, protocol, baseURL });
  const name = text(source.name, id === DEFAULT_PROVIDER_ID ? "OpenAI-compatible" : id);
  return {
    id,
    name,
    protocol,
    baseURL,
    ...(Object.keys(headers).length ? { headers } : {}),
    models,
    enabled: source.enabled !== false,
    requiresApiKey: typeof source.requiresApiKey === "boolean" ? source.requiresApiKey : !isLocalProviderUrl(baseURL),
    accountPool: normalizeProviderAccountPool(source.accountPool ?? source.pool, models),
  };
}

function strictBaseURL(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096) {
    throw new ProviderConfigError("provider_base_url_invalid");
  }
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) throw new Error("invalid");
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new ProviderConfigError("provider_base_url_invalid");
  }
}

/**
 * Strict route-boundary validation; migration keeps tolerant normalization.
 * `verifyLiveCapabilities`, when supplied by the gateway, receives sanitized
 * metadata with the renderer-provided origin removed. Only an exact, recent
 * discovery-cache match should return true.
 */
export function validateProviderInput(value, { creating = false, providerId, verifyLiveCapabilities } = {}) {
  const source = object(value);
  if (!creating && source.id !== undefined && normalizeExplicitProviderId(source.id) !== normalizeExplicitProviderId(providerId)) {
    throw new ProviderConfigError("provider_id_immutable");
  }
  const id = creating
    ? normalizeExplicitProviderId(source.id)
    : normalizeExplicitProviderId(providerId ?? source.id);
  const rawName = source.displayName ?? source.name;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name || name.length > MAX_PROVIDER_NAME) throw new ProviderConfigError("provider_name_invalid");
  const protocol = typeof source.protocol === "string" ? source.protocol.trim().toLowerCase() : "";
  if (!SUPPORTED_PROVIDER_PROTOCOLS.includes(protocol)) throw new ProviderConfigError("provider_protocol_invalid");
  const baseURL = strictBaseURL(source.baseURL);
  const models = validateModels(source.models, {
    providerId: id,
    protocol,
    baseURL,
    verifyLiveCapabilities,
  });
  const headers = normalizeHeaders(source.headers, { strict: true });
  return {
    id,
    name,
    protocol,
    baseURL,
    ...(Object.keys(headers).length ? { headers } : {}),
    models,
    enabled: source.enabled !== false,
    requiresApiKey: typeof source.requiresApiKey === "boolean" ? source.requiresApiKey : !isLocalProviderUrl(baseURL),
    accountPool: normalizeProviderAccountPool(source.accountPool ?? source.pool, models),
  };
}

/** Convert legacy single-provider data into a valid v3 registry shape. */
export function normalizeGatewayConfig(value) {
  const source = object(value);
  const supplied = Array.isArray(source.providers) ? source.providers : null;
  const providers = supplied && supplied.length
    ? supplied.map((provider, index) => normalizeProvider(provider, `provider-${index + 1}`))
    : [normalizeProvider({
      id: DEFAULT_PROVIDER_ID,
      name: "OpenAI-compatible",
      baseURL: source.provider,
      model: source.model,
    })];

  const unique = [];
  const ids = new Set();
  for (const provider of providers) {
    let id = provider.id;
    let suffix = 2;
    while (ids.has(id)) id = `${provider.id.slice(0, 56)}-${suffix++}`;
    ids.add(id);
    unique.push({ ...provider, id });
  }
  const requestedProvider = text(source.activeProviderId);
  const activeProvider = unique.find((provider) => provider.id === requestedProvider && provider.enabled) ?? unique.find((provider) => provider.enabled) ?? null;
  const requestedModel = text(source.activeModelId, text(source.model));
  const activeModelId = activeProvider
    ? activeProvider.models.some((model) => model.id === requestedModel)
      ? requestedModel
      : activeProvider.models[0].id
    : "";
  const workerSource = object(object(source.modelAssignments).worker);
  const workerProvider = unique.find((provider) => provider.id === text(workerSource.providerId) && provider.enabled);
  const workerModelId = text(workerSource.modelId);
  const worker = workerProvider?.models.some((model) => model.id === workerModelId)
    ? { providerId: workerProvider.id, modelId: workerModelId }
    : null;
  const fallbackRows = Array.isArray(object(source.modelAssignments).fallbacks)
    ? object(source.modelAssignments).fallbacks
    : [];
  const fallbackKeys = new Set();
  const fallbacks = [];
  for (const row of fallbackRows.slice(0, MAX_MODEL_FALLBACKS)) {
    const candidate = object(row);
    const providerId = text(candidate.providerId);
    const modelId = text(candidate.modelId);
    const provider = unique.find((item) => item.id === providerId && item.enabled);
    if (!provider?.models.some((model) => model.id === modelId)) continue;
    const key = `${providerId}\0${modelId}`;
    if (fallbackKeys.has(key)) continue;
    fallbackKeys.add(key);
    fallbacks.push({ providerId, modelId });
  }
  const orchestration = normalizeOrchestration(source.orchestration, unique);
  return {
    version: 3,
    activeProviderId: activeProvider?.id ?? "",
    activeModelId,
    providers: unique,
    modelAssignments: { ...(worker ? { worker } : {}), fallbacks },
    orchestration,
    pipelines: normalizePipelines(source.pipelines, orchestration.profiles),
    kiroOrganization: normalizeKiroOrganizationConfig(source.kiroOrganization ?? {}),
    workspace: typeof source.workspace === "string" ? source.workspace : "",
    engine: object(source.engine),
  };
}

function secretText(value, maxLength) {
  if (typeof value !== "string") return "";
  const candidate = value.trim();
  return candidate && candidate.length <= maxLength && !candidate.includes("\0") ? candidate : "";
}

/** Allowlist one provider secret record; unknown fields never reach disk. */
export function normalizeProviderSecret(value) {
  const source = object(value);
  const fields = {
    apiKey: 20_000,
    region: 128,
    accessKeyId: 1_024,
    secretAccessKey: 8_192,
    sessionToken: 20_000,
    project: 512,
    location: 128,
    clientEmail: 512,
    privateKey: 20_000,
  };
  const result = {};
  for (const [field, maxLength] of Object.entries(fields)) {
    const candidate = secretText(source[field], maxLength);
    if (candidate) result[field] = candidate;
  }
  return result;
}

export function normalizeProviderSecrets(value) {
  const source = object(value);
  const approvalSigningKey = secretText(source.approvalSigningKey, 512);
  const rawProviders = object(source.providers);
  const rawAccounts = object(source.accounts);
  const providers = {};
  const accounts = {};
  for (const [id, raw] of Object.entries(rawProviders)) {
    if (!PROVIDER_ACCOUNT_ID.test(id)) continue;
    const secret = normalizeProviderSecret(raw);
    if (Object.keys(secret).length) providers[id] = secret;
  }
  for (const [providerId, rawProviderAccounts] of Object.entries(rawAccounts)) {
    if (!PROVIDER_ACCOUNT_ID.test(providerId)) continue;
    const providerAccounts = {};
    for (const [accountId, raw] of Object.entries(object(rawProviderAccounts))) {
      if (accountId === "primary" || !PROVIDER_ACCOUNT_ID.test(accountId)) continue;
      const secret = normalizeProviderSecret(raw);
      if (Object.keys(secret).length) providerAccounts[accountId] = secret;
    }
    if (Object.keys(providerAccounts).length) accounts[providerId] = providerAccounts;
  }
  const messagingSource = object(source.messaging);
  const messagingToken = secretText(messagingSource.webhookToken, 256);
  return {
    version: 3,
    providers,
    accounts,
    ...(approvalSigningKey ? { approvalSigningKey } : {}),
    ...(messagingToken
      ? { messaging: { webhookToken: messagingToken } }
      : {}),
    kiroOrganization: serializeKiroOrganizationSecrets(
      normalizeKiroOrganizationSecrets(source.kiroOrganization),
    ),
  };
}

export function getProviderAccountCredentials(secretState, providerId, accountId = "primary") {
  return accountId === "primary"
    ? normalizeProviderSecret(object(secretState).providers?.[providerId])
    : normalizeProviderSecret(object(secretState).accounts?.[providerId]?.[accountId]);
}

export function setProviderAccountCredentials(secretState, providerId, accountId, value) {
  const next = normalizeProviderSecrets(secretState);
  const credentials = normalizeProviderSecret(value);
  if (!Object.keys(credentials).length) throw new ProviderConfigError("provider_credentials_required");
  if (accountId === "primary") next.providers[providerId] = credentials;
  else next.accounts[providerId] = { ...(next.accounts[providerId] ?? {}), [accountId]: credentials };
  return next;
}

export function deleteProviderAccountCredentials(secretState, providerId, accountId = "primary") {
  const next = normalizeProviderSecrets(secretState);
  if (accountId === "primary") delete next.providers[providerId];
  else if (next.accounts[providerId]) {
    delete next.accounts[providerId][accountId];
    if (!Object.keys(next.accounts[providerId]).length) delete next.accounts[providerId];
  }
  return next;
}

/**
 * Collect only values that are credentials. Routing metadata stored beside a
 * cloud routing metadata (region/project/location) must remain public
 * text and must never become an exact-redaction token.
 */
export function collectProviderCredentialValues(secretState, providers = []) {
  const values = [];
  const approvalSigningKey = secretText(object(secretState).approvalSigningKey, 512);
  if (approvalSigningKey) values.push(approvalSigningKey);
  for (const raw of Object.values(object(object(secretState).providers))) {
    const credential = normalizeProviderSecret(raw);
    for (const field of PROVIDER_CREDENTIAL_VALUE_FIELDS) {
      const value = credential[field];
      if (typeof value === "string" && value.length > 0) values.push(value);
    }
  }
  for (const providerAccounts of Object.values(object(object(secretState).accounts))) {
    for (const raw of Object.values(object(providerAccounts))) {
      const credential = normalizeProviderSecret(raw);
      for (const field of PROVIDER_CREDENTIAL_VALUE_FIELDS) {
        const value = credential[field];
        if (typeof value === "string" && value.length > 0) values.push(value);
      }
    }
  }
  for (const provider of Array.isArray(providers) ? providers : []) {
    for (const [name, value] of Object.entries(object(object(provider).headers))) {
      if (SECRET_HEADER_NAME.test(name) && typeof value === "string" && value.length > 0) {
        values.push(value);
      }
    }
  }
  for (const secret of normalizeKiroOrganizationSecrets(object(secretState).kiroOrganization).values()) {
    if (typeof secret.apiKey === "string" && secret.apiKey.length > 0) values.push(secret.apiKey);
  }
  return values;
}

export function hasStoredProviderCredentials(provider, secretValue) {
  if (!provider.requiresApiKey) return true;
  const secret = normalizeProviderSecret(secretValue);
  switch (provider.protocol) {
    case "amazon-bedrock":
      return Boolean(secret.region && (secret.apiKey || (secret.accessKeyId && secret.secretAccessKey)));
    case "google-vertex":
      return Boolean(secret.project && secret.location && secret.clientEmail && secret.privateKey);
    default:
      return Boolean(secret.apiKey);
  }
}

export function readyProviderAccounts(provider, secretState) {
  const pool = normalizeProviderAccountPool(provider.accountPool, provider.models);
  const members = pool.enabled ? pool.members : pool.members.filter((member) => member.id === "primary");
  return members.filter((member) => member.enabled && hasStoredProviderCredentials(
    provider,
    getProviderAccountCredentials(secretState, provider.id, member.id),
  ));
}

export function hasReadyProviderCredentials(provider, secretState) {
  return readyProviderAccounts(provider, secretState).length > 0;
}

export function getActiveProvider(config) {
  return config.providers.find((provider) => provider.id === config.activeProviderId && provider.enabled)
    ?? config.providers.find((provider) => provider.enabled)
    ?? null;
}

export function publicGatewayConfig(config, secrets) {
  const active = getActiveProvider(config);
  const orchestration = normalizeOrchestration(config.orchestration, config.providers);
  const safeProviders = config.providers.map((provider) => ({
    ...provider,
    accountPool: {
      ...normalizeProviderAccountPool(provider.accountPool, provider.models),
      members: normalizeProviderAccountPool(provider.accountPool, provider.models).members.map((member) => {
        const credentials = getProviderAccountCredentials(secrets, provider.id, member.id);
        return {
          ...member,
          primary: member.id === "primary",
          hasStoredCredentials: Object.keys(credentials).length > 0,
          ready: hasStoredProviderCredentials(provider, credentials),
        };
      }),
    },
    hasKey: hasReadyProviderCredentials(provider, secrets),
    hasStoredCredentials: Object.keys(getProviderAccountCredentials(secrets, provider.id)).length > 0,
  }));
  const messaging = object(object(config.engine).messaging);
  return {
    provider: active?.baseURL ?? "",
    model: config.activeModelId ?? "",
    workspace: config.workspace ?? "",
    hasKey: active ? hasReadyProviderCredentials(active, secrets) : false,
    activeProviderId: active?.id ?? "",
    activeProviderName: active?.name ?? "",
    activeModelId: config.activeModelId ?? "",
    providers: safeProviders,
    modelAssignments: object(config.modelAssignments),
    orchestration,
    pipelines: normalizePipelines(config.pipelines, orchestration.profiles),
    engine: object(config.engine),
    messaging: {
      enabled: messaging.enabled === true,
      autoRun: messaging.autoRun === true,
      maxBodyChars: typeof messaging.maxBodyChars === "number" ? messaging.maxBodyChars : 8_000,
      hasToken: typeof secrets?.messaging?.webhookToken === "string"
        && secrets.messaging.webhookToken.trim().length >= 16,
    },
  };
}

export function createProviderId(name, providers) {
  const base = normalizeId(name, "provider");
  const known = new Set(providers.map((provider) => provider.id));
  if (!known.has(base)) return base;
  let suffix = 2;
  while (known.has(`${base.slice(0, 56)}-${suffix}`)) suffix += 1;
  return `${base.slice(0, 56)}-${suffix}`;
}

export function upsertProvider(config, input, forcedId) {
  const source = object(input);
  const existing = forcedId ? config.providers.find((provider) => provider.id === forcedId) : null;
  const id = forcedId ?? normalizeId(source.id, createProviderId(source.name, config.providers));
  const provider = normalizeProvider({ ...(existing ?? {}), ...source, id }, id);
  const index = config.providers.findIndex((item) => item.id === id);
  const providers = [...config.providers];
  if (index >= 0) providers[index] = provider;
  else providers.push(provider);
  const next = { ...config, providers };
  return { config: normalizeGatewayConfig(next), provider };
}

export class ProviderConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProviderConfigError";
    this.code = code;
  }
}

export function validateProviderModelId(value) {
  const modelId = typeof value === "string" ? value.trim() : "";
  if (!modelId || modelId.length > MAX_MODEL_ID || /[\u0000-\u001f\u007f]/.test(modelId)) {
    throw new ProviderConfigError("provider_model_invalid");
  }
  return modelId;
}

/** Select a provider/model; entering a new model id adds it to that provider. */
export function selectProviderModel(config, providerId, requestedModel) {
  const provider = config.providers.find((item) => item.id === providerId && item.enabled);
  if (!provider) throw new ProviderConfigError("provider_unavailable");
  const modelId = text(requestedModel, provider.models[0]?.id ?? DEFAULT_MODEL);
  validateProviderModelId(modelId);
  const exists = provider.models.some((model) => model.id === modelId);
  if (!exists && provider.models.length >= MAX_PROVIDER_MODELS) throw new ProviderConfigError("provider_model_invalid");
  const models = exists ? provider.models : [...provider.models, { id: modelId }];
  const providers = config.providers.map((item) => item.id === provider.id ? { ...item, models } : item);
  return normalizeGatewayConfig({ ...config, providers, activeProviderId: provider.id, activeModelId: modelId });
}

/** Resolve a provider-scoped model reference without moving credentials. */
export function resolveProviderModel(config, providerId, modelId, { fallbackToDefault = false } = {}) {
  const provider = config.providers.find((item) => item.id === providerId && item.enabled);
  const model = provider?.models.find((item) => item.id === modelId);
  if (provider && model) return { provider, model };
  if (fallbackToDefault) {
    const active = getActiveProvider(config);
    const activeModel = active?.models.find((item) => item.id === config.activeModelId) ?? active?.models[0];
    if (active && activeModel) return { provider: active, model: activeModel };
  }
  if (!provider) throw new ProviderConfigError("provider_unavailable");
  throw new ProviderConfigError("provider_model_unavailable");
}

export function removeProvider(config, providerId) {
  if (config.providers.length <= 1) throw new ProviderConfigError("provider_final_profile");
  const providers = config.providers.filter((provider) => provider.id !== providerId);
  if (providers.length === config.providers.length) throw new ProviderConfigError("provider_not_found");
  const activeRemoved = config.activeProviderId === providerId;
  const nextActive = activeRemoved ? providers.find((provider) => provider.enabled) ?? null : null;
  return normalizeGatewayConfig({
    ...config,
    providers,
    activeProviderId: activeRemoved ? nextActive?.id ?? "" : config.activeProviderId,
    activeModelId: activeRemoved ? nextActive?.models[0]?.id ?? "" : config.activeModelId,
  });
}
