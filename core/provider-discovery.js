import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import {
  extractLiveModelCapabilities,
  resolveModelCapabilities,
} from "./model-capabilities.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_MODELS = 2_000;
const MAX_MODEL_ID = 512;
const MAX_MODEL_NAME = 512;
const USER_AGENT = "Kyrei-Provider-Discovery/1.0";
const DEFAULT_MAX_REDIRECTS = 3;

export class ProviderDiscoveryError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProviderDiscoveryError";
    this.code = code;
  }
}

function discoveryError(code) {
  return new ProviderDiscoveryError(code);
}

function ipv4Parts(address) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isLoopbackIpv4(address) {
  const parts = ipv4Parts(address);
  return Boolean(parts && parts[0] === 127);
}

/** RFC1918 LAN — allowed for user-configured local model servers (Ollama etc.). */
function isPrivateLanIpv4(address) {
  const parts = ipv4Parts(address);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function isBenchmarkIpv4(address) {
  const parts = ipv4Parts(address);
  return Boolean(parts && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19));
}

/**
 * Still blocked: unspecified, link-local/metadata, CGNAT, documentation ranges,
 * 6to4 relay, multicast. RFC1918 is NOT blocked — see isPrivateLanIpv4.
 */
function isBlockedIpv4(address) {
  const parts = ipv4Parts(address);
  if (!parts) return true;
  const [a, b, c] = parts;
  if (isPrivateLanIpv4(address)) return false;
  return (
    a === 0 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6Words(raw) {
  const value = raw.toLowerCase();
  if (!value || value.includes("%") || value.split("::").length > 2) return null;
  const expand = (part) => {
    if (!part) return [];
    const fields = part.split(":");
    const words = [];
    for (let index = 0; index < fields.length; index += 1) {
      const field = fields[index] ?? "";
      if (/^\d+\.\d+\.\d+\.\d+$/.test(field)) {
        if (index !== fields.length - 1) return null;
        const octets = ipv4Parts(field);
        if (!octets) return null;
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(field)) return null;
        words.push(Number.parseInt(field, 16));
      }
    }
    return words;
  };
  const [leftRaw, rightRaw] = value.split("::");
  const left = expand(leftRaw ?? "");
  const right = expand(rightRaw ?? "");
  if (!left || !right) return null;
  if (!value.includes("::")) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  return missing >= 1 ? [...left, ...Array(missing).fill(0), ...right] : null;
}

function mappedIpv4(words) {
  if (words.length !== 8 || !words.slice(0, 5).every((word) => word === 0)) return null;
  if (words[5] !== 0 && words[5] !== 0xffff) return null;
  return `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
}

function addressPolicy(address) {
  const normalized = address.trim().replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(normalized);
  if (family === 4) {
    if (isLoopbackIpv4(normalized)) return "loopback";
    if (isPrivateLanIpv4(normalized)) return "private";
    if (isBenchmarkIpv4(normalized)) return "benchmark";
    return isBlockedIpv4(normalized) ? "blocked" : "public";
  }
  if (family !== 6) return "blocked";
  const words = parseIpv6Words(normalized);
  if (!words) return "blocked";
  if (normalized === "::1") return "loopback";
  // Unique local addresses (fc00::/7) — home/lab private IPv6.
  const first = words[0] ?? 0;
  const second = words[1] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return "private";
  const embedded = mappedIpv4(words);
  if (embedded) {
    if (isLoopbackIpv4(embedded)) return "loopback";
    if (isPrivateLanIpv4(embedded)) return "private";
    if (isBenchmarkIpv4(embedded)) return "benchmark";
    return isBlockedIpv4(embedded) ? "blocked" : "public";
  }
  if (
    words.every((word) => word === 0) ||
    (first === 0x0064 && second === 0xff9b && (
      words.slice(2, 6).every((word) => word === 0) ||
      words[2] === 1
    )) ||
    (first === 0x0100 && second === 0 && words.slice(2, 4).every((word) => word === 0)) ||
    (first === 0x2001 && second <= 0x01ff) ||
    (first === 0x2001 && second === 0x0db8) ||
    first === 0x2002 ||
    (first === 0x3fff && (second & 0xf000) === 0) ||
    first === 0x5f00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00
  ) return "blocked";
  return "public";
}

function isTrustedLocalPolicy(policy) {
  return policy === "loopback" || policy === "private";
}

async function defaultResolveHost(hostname) {
  return (await dnsLookup(hostname, { all: true, verbatim: true }))
    .filter((entry) => entry.family === 4 || entry.family === 6)
    .map((entry) => ({ address: entry.address, family: entry.family }));
}

function parseEndpoint(baseURL, protocol) {
  let url;
  try {
    url = new URL(String(baseURL ?? "").trim());
  } catch {
    throw discoveryError("provider_base_url_invalid");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) throw discoveryError("provider_base_url_invalid");
  const endpoint = new URL(`${url.href.replace(/\/+$/, "")}/models`);
  if (protocol === "anthropic-messages") endpoint.searchParams.set("limit", "1000");
  if (protocol === "google-generative-ai") endpoint.searchParams.set("pageSize", "1000");
  return endpoint;
}

function normalizedOrigin(url) {
  return new URL(url.origin).href.replace(/\/+$/, "");
}

function allowedInsecureOrigins(value) {
  const rows = Array.isArray(value) ? value : [];
  const origins = new Set();
  for (const row of rows) {
    if (typeof row !== "string" || !row.trim()) continue;
    try {
      const url = new URL(row.trim());
      if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) continue;
      origins.add(normalizedOrigin(url));
    } catch {
      // ignore malformed entries
    }
  }
  return origins;
}

function redirectLocation(headers) {
  const value = headerValue(headers, "location");
  return typeof value === "string" ? value.trim() : "";
}

async function resolveTarget(url, resolveHost, { trustedEndpoint = false } = {}) {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw discoveryError("provider_base_url_invalid");
  if (isIP(host)) {
    const policy = addressPolicy(host);
    // The gateway passes trustedEndpoint only after the user explicitly enters
    // this provider endpoint. The standalone discovery helper stays SSRF-safe.
    if (!trustedEndpoint && policy !== "public" && !isTrustedLocalPolicy(policy)) {
      throw discoveryError("provider_discovery_target_blocked");
    }
    return {
      address: host,
      family: isIP(host),
      loopback: policy === "loopback",
      privateLan: policy === "private",
    };
  }

  let addresses;
  try {
    addresses = await resolveHost(host);
  } catch {
    throw discoveryError("provider_discovery_unavailable");
  }
  if (!Array.isArray(addresses) || !addresses.length) throw discoveryError("provider_discovery_unavailable");
  const localhost = host === "localhost" || host.endsWith(".localhost");
  const policies = addresses.map((entry) => addressPolicy(entry.address));
  if (trustedEndpoint) {
    // A provider URL is an explicit user trust decision. Keep resolving and
    // pinning every connection so DNS cannot change mid-request, but do not
    // force users through a second network-range checkbox for their own VPN,
    // LAN, Fake-IP proxy, or self-hosted endpoint.
  } else if (localhost) {
    if (policies.some((policy) => policy !== "loopback")) throw discoveryError("provider_discovery_target_blocked");
  } else {
    if (policies.some((policy) => policy === "blocked")) {
      throw discoveryError("provider_discovery_target_blocked");
    }
    const hasPublic = policies.some((policy) => policy === "public");
    const hasPrivate = policies.some((policy) => policy === "private");
    const hasBenchmark = policies.includes("benchmark");
    // Refuse mixed public+private DNS (SSRF pivot risk).
    if (hasPublic && hasPrivate) throw discoveryError("provider_discovery_target_blocked");
    if (hasPrivate && hasBenchmark) throw discoveryError("provider_discovery_target_blocked");
    if (hasBenchmark) throw discoveryError("provider_discovery_target_blocked");
    // Pure private LAN hostname (e.g. nas.home → 192.168.x) or pure public.
    if (!hasPublic && !hasPrivate) {
      throw discoveryError("provider_discovery_target_blocked");
    }
  }
  const selected = addresses[0];
  const selectedPolicy = addressPolicy(selected.address);
  return {
    address: selected.address,
    family: selected.family,
    loopback: localhost || selectedPolicy === "loopback",
    privateLan: selectedPolicy === "private" || (!localhost && policies.every((p) => p === "private")),
  };
}

function defaultRequest(url, { headers, signal, pinnedAddress }) {
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const lookup = (_hostname, options, callback) => {
      const selected = { address: pinnedAddress.address, family: pinnedAddress.family };
      if (options && typeof options === "object" && options.all === true) {
        callback(null, [selected]);
        return;
      }
      callback(null, selected.address, selected.family);
    };
    const request = transport(url, { method: "GET", headers, lookup }, (incoming) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      incoming.once("close", cleanup);
      resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: incoming });
    });
    const onAbort = () => request.destroy(new Error("aborted"));
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    request.once("error", (error) => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) ?? "";
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
}

function disposeResponseBody(response) {
  try {
    response?.body?.destroy?.();
  } catch {
    // Best-effort disposal must not replace the stable discovery error.
  }
  try {
    const cancellation = response?.body?.cancel?.();
    cancellation?.catch?.(() => {});
  } catch {
    // Best-effort disposal must not replace the stable discovery error.
  }
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(headerValue(response.headers, "content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    disposeResponseBody(response);
    throw discoveryError("provider_discovery_response_too_large");
  }
  if (typeof response.body === "string" || Buffer.isBuffer(response.body)) {
    const value = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body, "utf8");
    if (value.byteLength > maxBytes) throw discoveryError("provider_discovery_response_too_large");
    return value.toString("utf8");
  }
  if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size > maxBytes) {
        disposeResponseBody(response);
        throw discoveryError("provider_discovery_response_too_large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw discoveryError("provider_discovery_response_too_large");
    return text;
  }
  throw discoveryError("provider_discovery_invalid_response");
}

function credentialNeedles(credentials) {
  const substrings = new Set();
  const exact = new Set();
  for (const value of Object.values(credentials && typeof credentials === "object" ? credentials : {})) {
    if (typeof value !== "string" || !value.trim()) continue;
    const secret = value.trim();
    if (secret.length < 4) {
      exact.add(secret);
      continue;
    }
    substrings.add(secret);
    for (const line of secret.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate.length >= 8) substrings.add(candidate);
    }
    if (secret.length > 64) {
      substrings.add(secret.slice(0, 32));
      substrings.add(secret.slice(-32));
    }
  }
  return { substrings: [...substrings], exact };
}

function containsCredential(value, needles) {
  return needles.exact.has(value) || needles.substrings.some((secret) => value.includes(secret));
}

function sanitizeModels(payload, maxModels, credentials, capabilityContext = {}) {
  const rows = capabilityContext.protocol === "google-generative-ai" && Array.isArray(payload?.models)
    ? payload.models
    : payload?.data;
  if (!payload || typeof payload !== "object" || !Array.isArray(rows)) {
    throw discoveryError("provider_discovery_invalid_response");
  }
  const needles = credentialNeedles(credentials);
  const models = [];
  const seen = new Set();
  for (const row of rows) {
    if (models.length >= maxModels) break;
    if (!row || typeof row !== "object") continue;
    const rawId = typeof row.id === "string"
      ? row.id.trim()
      : capabilityContext.protocol === "google-generative-ai" && typeof row.name === "string"
        ? row.name.trim().replace(/^models\//, "")
        : "";
    const id = rawId;
    if (!id || id.length > MAX_MODEL_ID || seen.has(id) || containsCredential(id, needles)) continue;
    seen.add(id);
    const rawName = typeof row.display_name === "string"
      ? row.display_name.trim()
      : typeof row.displayName === "string"
        ? row.displayName.trim()
        : capabilityContext.protocol !== "google-generative-ai" && typeof row.name === "string"
          ? row.name.trim()
          : "";
    const name = rawName && !containsCredential(rawName, needles) ? rawName.slice(0, MAX_MODEL_NAME) : "";
    const live = extractLiveModelCapabilities(row, { retrievedAt: capabilityContext.retrievedAt });
    const capabilities = resolveModelCapabilities({
      providerId: capabilityContext.providerId,
      baseURL: capabilityContext.baseURL,
      modelId: id,
      live,
    });
    models.push({
      id,
      ...(name ? { name } : {}),
      ...(capabilities.provenance.source !== "unknown" ? { capabilities } : {}),
    });
  }
  return models;
}

function safeHeaders(value, apiKey, protocol) {
  const headers = { Accept: "application/json", "User-Agent": USER_AGENT };
  if (value && typeof value === "object") {
    for (const [key, raw] of Object.entries(value)) {
      if (
        !/^[A-Za-z0-9-]{1,100}$/.test(key) ||
        /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-goog-api-key|x-amz-security-token|x-amz-credential|host|connection|transfer-encoding|content-length)$/i.test(key) ||
        typeof raw !== "string" ||
        raw.length > 2_000
      ) continue;
      headers[key] = raw;
    }
  }
  if (apiKey && protocol === "anthropic-messages") {
    headers["X-Api-Key"] = apiKey;
    headers["Anthropic-Version"] = "2023-06-01";
  } else if (apiKey && protocol === "google-generative-ai") {
    headers["X-Goog-Api-Key"] = apiKey;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function assertAllowedDiscoveryOrigin(endpoint, pinnedAddress, options) {
  if (options.trustedEndpoint === true) return;
  // HTTP is allowed only for trusted local targets (loopback or RFC1918 LAN).
  // Public internet discovery requires an exact-origin opt-in.
  if (endpoint.protocol !== "https:" && !pinnedAddress.loopback && !pinnedAddress.privateLan) {
    const allowedOrigins = allowedInsecureOrigins(options.allowInsecureHttpOrigins);
    if (!allowedOrigins.has(normalizedOrigin(endpoint))) {
      throw discoveryError("provider_discovery_target_blocked");
    }
  }
}

async function performDiscovery(options, signal) {
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const request = options.request ?? defaultRequest;
  const headers = safeHeaders(options.headers, options.credentials?.apiKey, options.protocol);
  const maxRedirects = Math.min(DEFAULT_MAX_REDIRECTS, Math.max(0, Number.isFinite(Number(options.maxRedirects)) ? Math.floor(Number(options.maxRedirects)) : DEFAULT_MAX_REDIRECTS));
  let endpoint = parseEndpoint(options.baseURL, options.protocol);
  const origin = normalizedOrigin(endpoint);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const pinnedAddress = await resolveTarget(endpoint, resolveHost, {
      trustedEndpoint: options.trustedEndpoint === true,
    });
    assertAllowedDiscoveryOrigin(endpoint, pinnedAddress, options);
    if (signal.aborted) throw new Error("aborted");
    let response;
    try {
      response = await request(endpoint, {
        headers,
        signal,
        pinnedAddress,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof ProviderDiscoveryError) throw error;
      throw new Error("request-failed");
    }
    const status = Number(response?.status ?? 0);
    if (status >= 300 && status < 400) {
      const location = redirectLocation(response?.headers);
      disposeResponseBody(response);
      if (!location) throw discoveryError("provider_discovery_redirect_blocked");
      let next;
      try {
        next = new URL(location, endpoint);
      } catch {
        throw discoveryError("provider_discovery_redirect_blocked");
      }
      if (
        (next.protocol !== "http:" && next.protocol !== "https:")
        || next.username
        || next.password
        || next.hash
        || normalizedOrigin(next) !== origin
      ) throw discoveryError("provider_discovery_redirect_blocked");
      endpoint = next;
      continue;
    }
    if (status === 401 || status === 403) {
      disposeResponseBody(response);
      throw discoveryError("provider_discovery_unauthorized");
    }
    if (status === 429) {
      disposeResponseBody(response);
      throw discoveryError("provider_discovery_rate_limited");
    }
    if (status < 200 || status >= 300) {
      disposeResponseBody(response);
      throw discoveryError("provider_discovery_unavailable");
    }
    const body = await readBoundedBody(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw discoveryError("provider_discovery_invalid_response");
    }
    const requestedMax = Number(options.maxModels ?? DEFAULT_MAX_MODELS);
    const maxModels = Math.min(DEFAULT_MAX_MODELS, Math.max(1, Number.isFinite(requestedMax) ? Math.floor(requestedMax) : DEFAULT_MAX_MODELS));
    const retrievedAt = typeof options.now === "function" ? options.now() : Date.now();
    return sanitizeModels(payload, maxModels, options.credentials, {
      providerId: options.providerId,
      baseURL: options.baseURL,
      protocol: options.protocol,
      retrievedAt,
    });
  }
  throw discoveryError("provider_discovery_redirect_blocked");
}

/** Discover models from bounded official/OpenAI-compatible read-only model catalogs. */
export async function discoverProviderModels(options) {
  if (!["openai-chat", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(options?.protocol)) {
    throw discoveryError("provider_discovery_unsupported");
  }
  if (options.signal?.aborted) throw discoveryError("provider_discovery_unavailable");
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = Math.min(60_000, Math.max(1, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await Promise.race([
      performDiscovery(options, controller.signal),
      new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    ]);
  } catch (error) {
    if (error instanceof ProviderDiscoveryError) throw error;
    if (timedOut) throw discoveryError("provider_discovery_timeout");
    throw discoveryError("provider_discovery_unavailable");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
