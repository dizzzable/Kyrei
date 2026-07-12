/**
 * Versioned provider-registry configuration used by the local gateway.
 *
 * Provider metadata is safe to return to the renderer; API keys live in a
 * separate secrets file managed by the gateway. The registry intentionally
 * supports only Kyrei's built-in OpenAI-compatible protocol — it never loads
 * arbitrary packages from user configuration.
 */

export const SUPPORTED_PROVIDER_PROTOCOLS = ["openai-chat", "openai-responses", "anthropic-messages"];
const DEFAULT_PROVIDER_ID = "default-openai-compatible";
const DEFAULT_PROTOCOL = "openai-chat";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URLS = {
  "openai-chat": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com/v1",
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

export function isLocalProviderUrl(baseURL) {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === "localhost" || host === "0.0.0.0" || host === "::1" || host === "[::1]" || host === "127.0.0.1";
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
    if (url.username || url.password) return fallback;
    return url.href.replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function normalizeModels(value, fallbackModel) {
  const rows = Array.isArray(value) ? value : [];
  const seen = new Set();
  const models = [];
  for (const row of rows) {
    const source = typeof row === "string" ? { id: row } : object(row);
    const id = text(source.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = text(source.name);
    models.push({ id, ...(name ? { name } : {}) });
  }
  if (!models.length) models.push({ id: text(fallbackModel, DEFAULT_MODEL) });
  return models;
}

function normalizeHeaders(value) {
  const headers = {};
  for (const [key, raw] of Object.entries(object(value))) {
    // The registry is returned to the renderer, so it must never carry a
    // credential-bearing header. API keys use the separate secrets endpoint.
    if (!/^[A-Za-z0-9-]{1,100}$/.test(key) || /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i.test(key) || typeof raw !== "string" || raw.length > 2000) continue;
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
  const models = normalizeModels(source.models, source.model);
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
  };
}

/** Convert legacy single-provider data into a valid v2 registry shape. */
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
  const activeProvider = unique.find((provider) => provider.id === requestedProvider && provider.enabled) ?? unique.find((provider) => provider.enabled) ?? unique[0];
  const requestedModel = text(source.activeModelId, text(source.model));
  const activeModelId = activeProvider.models.some((model) => model.id === requestedModel)
    ? requestedModel
    : activeProvider.models[0].id;
  return {
    version: 2,
    activeProviderId: activeProvider.id,
    activeModelId,
    providers: unique,
    workspace: typeof source.workspace === "string" ? source.workspace : "",
    engine: object(source.engine),
  };
}

export function normalizeProviderSecrets(value) {
  const source = object(value);
  const rawProviders = object(source.providers);
  const providers = {};
  for (const [id, raw] of Object.entries(rawProviders)) {
    const apiKey = text(object(raw).apiKey);
    if (apiKey) providers[id] = { apiKey };
  }
  return { version: 1, providers };
}

export function getActiveProvider(config) {
  return config.providers.find((provider) => provider.id === config.activeProviderId) ?? config.providers[0] ?? null;
}

export function publicGatewayConfig(config, secrets) {
  const active = getActiveProvider(config);
  const safeProviders = config.providers.map((provider) => ({
    ...provider,
    hasKey: !provider.requiresApiKey || Boolean(secrets.providers?.[provider.id]?.apiKey),
  }));
  return {
    provider: active?.baseURL ?? "",
    model: config.activeModelId ?? "",
    workspace: config.workspace ?? "",
    hasKey: active ? (!active.requiresApiKey || Boolean(secrets.providers?.[active.id]?.apiKey)) : false,
    activeProviderId: active?.id ?? "",
    activeProviderName: active?.name ?? "",
    activeModelId: config.activeModelId ?? "",
    providers: safeProviders,
    engine: object(config.engine),
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

/** Select a provider/model; entering a new model id adds it to that provider. */
export function selectProviderModel(config, providerId, requestedModel) {
  const provider = config.providers.find((item) => item.id === providerId && item.enabled);
  if (!provider) throw new Error("provider is unavailable");
  const modelId = text(requestedModel, provider.models[0]?.id ?? DEFAULT_MODEL);
  const models = provider.models.some((model) => model.id === modelId) ? provider.models : [...provider.models, { id: modelId }];
  const providers = config.providers.map((item) => item.id === provider.id ? { ...item, models } : item);
  return { ...config, providers, activeProviderId: provider.id, activeModelId: modelId };
}

export function removeProvider(config, providerId) {
  if (config.providers.length <= 1) throw new Error("the final provider cannot be removed");
  const providers = config.providers.filter((provider) => provider.id !== providerId);
  if (providers.length === config.providers.length) throw new Error("provider was not found");
  const nextActive = config.activeProviderId === providerId ? providers.find((provider) => provider.enabled) ?? providers[0] : getActiveProvider({ ...config, providers });
  return {
    ...config,
    providers,
    activeProviderId: nextActive.id,
    activeModelId: nextActive.models[0]?.id ?? DEFAULT_MODEL,
  };
}
