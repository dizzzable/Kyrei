import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { SessionStore } from "./session-store.js";
import {
  createProviderId,
  getActiveProvider,
  normalizeGatewayConfig,
  normalizeProviderSecrets,
  publicGatewayConfig,
  removeProvider,
  selectProviderModel,
  upsertProvider,
} from "./provider-config.js";

/**
 * Kyrei gateway — local HTTP server that the renderer talks to.
 *
 * Transport: Server-Sent Events for the model event stream (one subscription
 * per session) + plain JSON POST for commands. No external deps, works over
 * the Electron renderer's fetch/EventSource.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /api/status                     -> runtime + provider summary (no secrets)
 *   GET  /api/config                     -> { provider, model, workspace, hasKey }
 *   PUT  /api/config                     -> set provider/apiKey/model/workspace
 *   POST /api/choose-folder              -> { folder } (native picker)
 *   GET  /api/sessions                   -> { sessions }
 *   POST /api/sessions                   -> create -> { id }
 *   GET  /api/sessions/:id/messages      -> { messages }
 *   PATCH  /api/sessions/:id             -> rename { title }
 *   DELETE /api/sessions/:id             -> remove
 *   GET  /api/events?session=<id>        -> SSE event stream for a session
 *   POST /api/prompt   { session, text, modelParams? } -> run a turn (emits over SSE)
 *   POST /api/cancel   { session }       -> cancel the running turn
 */

const CORS_BASE = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Kyrei-Gateway-Token",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...(res.kyreiCors ?? {}) });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 20_000_000) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

export async function startGateway({ dataDir, chooseFolder, preferredPort = 8765, authToken, rendererOrigin = "null" } = {}) {
  // The local port is not an authentication boundary: any web page can target
  // loopback. Every API request carries this per-launch capability token.
  const gatewayToken = typeof authToken === "string" && authToken.length >= 32
    ? authToken
    : randomBytes(32).toString("base64url");

  const tokenMatches = (candidate) => {
    if (typeof candidate !== "string") return false;
    const actual = Buffer.from(candidate);
    const expected = Buffer.from(gatewayToken);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const isLoopbackHost = (host) => /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(String(host ?? ""));
  // Chromium normally serializes file origins as `null`; accept `file://` as
  // well for platform variants. Both still require the launch capability.
  const allowedOrigins = new Set(rendererOrigin === "null" ? ["null", "file://"] : [rendererOrigin]);
  const isExpectedOrigin = (origin) => !origin || allowedOrigins.has(origin);
  const corsFor = (origin) => allowedOrigins.has(origin)
    ? { ...CORS_BASE, "Access-Control-Allow-Origin": origin, Vary: "Origin" }
    : {};
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dataDir, "kyrei-config.json");

  const secretsPath = join(dataDir, "kyrei-secrets.json");
  let rawConfig = {};
  try { rawConfig = JSON.parse(await readFile(configPath, "utf8")); } catch { /* first run */ }
  let config = normalizeGatewayConfig(rawConfig);
  let secrets = {};
  try { secrets = normalizeProviderSecrets(JSON.parse(await readFile(secretsPath, "utf8"))); } catch { secrets = normalizeProviderSecrets({}); }
  const legacyApiKey = typeof rawConfig.apiKey === "string" ? rawConfig.apiKey : "";
  if (legacyApiKey && !secrets.providers[config.activeProviderId]?.apiKey) {
    secrets.providers[config.activeProviderId] = { apiKey: legacyApiKey };
  }
  const saveConfig = async () => {
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    await writeFile(secretsPath, JSON.stringify(secrets, null, 2), { encoding: "utf8", mode: 0o600 });
    // `mode` affects only newly created files. Reassert Unix permissions after
    // every write; Windows ACL/keychain hardening remains a platform follow-up.
    if (process.platform !== "win32") await chmod(secretsPath, 0o600);
  };
  await saveConfig();

  const store = new SessionStore({ runtimeDir: dataDir });
  await store.load();

  // SSE subscribers + per-session AbortControllers, keyed by session id.
  const subscribers = new Map(); // sessionId -> Set<res>
  const controllers = new Map(); // sessionId -> AbortController
  const runtimeStatus = new Map(); // sessionId -> "working" (absent = idle)

  // The engine is a built ESM bundle, loaded lazily on first prompt.
  let engine = null;
  const getEngine = async () => {
    if (!engine) engine = await import("./engine/.dist/index.mjs");
    return engine;
  };

  function emitTo(sessionId, event) {
    const set = subscribers.get(sessionId);
    if (!set) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) { try { res.write(frame); } catch { /* dropped */ } }
  }

  function publicConfig() {
    // `engine` tuning is non-secret (permissions/roles/budgets), so it is safe
    // to echo back for the settings Advanced pane. The apiKey is never exposed —
    // only `hasKey`.
    return publicGatewayConfig(config, secrets);
  }

  function convoFor(sessionId) {
    return store.getMessages(sessionId)
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: m.content }));
  }

  async function runPrompt(sessionId, text, modelParams) {
    const session = store.getSession(sessionId);
    if (!session) return;

    store.appendMessage(sessionId, { role: "user", content: text });
    if (!session.title || session.title === "Новый диалог") {
      store.upsertSession({ id: sessionId, title: text.slice(0, 48) + (text.length > 48 ? "…" : ""), updatedAt: new Date().toISOString() });
      emitTo(sessionId, { type: "session.title", payload: { session_id: sessionId, title: store.getSession(sessionId).title } });
    }

    const activeProvider = getActiveProvider(config);
    if (!activeProvider) {
      emitTo(sessionId, { type: "error", payload: { message: "No provider is configured." } });
      emitTo(sessionId, { type: "message.complete", payload: { text: "", status: "error" } });
      return;
    }
    const common = {
      emit: event => emitTo(sessionId, event),
      messages: convoFor(sessionId),
      providerBase: activeProvider.baseURL,
      providerId: activeProvider.id,
      providerHeaders: activeProvider.headers,
      requiresApiKey: activeProvider.requiresApiKey,
      apiKey: secrets.providers[activeProvider.id]?.apiKey ?? "",
      model: config.activeModelId,
      workspace: config.workspace,
      auditLogPath: join(dataDir, "audit.jsonl"),
    };

    const controller = new AbortController();
    controllers.set(sessionId, controller);
    runtimeStatus.set(sessionId, "working");

    try {
      const mod = await getEngine();
      const run = mod.runKyreiChat({
        ...common,
        abortSignal: controller.signal,
        config: config.engine,
        ...(modelParams && typeof modelParams === "object" ? { modelParams } : {}),
      });

      await run.then(({ text, parts }) => {
        store.appendMessage(sessionId, { role: "assistant", content: text, parts });
        store.upsertSession({ id: sessionId, updatedAt: new Date().toISOString() });
      }).catch(err => {
        // Cancellation is not an error (Property 2): finish the turn as
        // "interrupted" so the UI clears its pending state without a red banner.
        const aborted = err?.name === "AbortError" || /abort/i.test(String(err?.message || ""));
        if (aborted) {
          emitTo(sessionId, { type: "message.complete", payload: { text: "", status: "interrupted" } });
        } else {
          emitTo(sessionId, { type: "error", payload: { message: err?.message || String(err) } });
          // Always close the turn so the renderer clears its pending bubble.
          emitTo(sessionId, { type: "message.complete", payload: { text: "", status: "error" } });
        }
      });
    } catch (err) {
      // A synchronous throw or a failed engine-bundle import must not become an
      // unhandled rejection (would crash the gateway) — surface it and end turn.
      emitTo(sessionId, { type: "error", payload: { message: err?.message || String(err) } });
      emitTo(sessionId, { type: "message.complete", payload: { text: "", status: "error" } });
    } finally {
      controllers.delete(sessionId);
      runtimeStatus.delete(sessionId);
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    res.kyreiCors = corsFor(origin);

    // Bind only to loopback and reject spoofed browser origins before any
    // response that a page could read. The bearer token remains mandatory even
    // for file:// (Origin: null) renderers.
    if (!isLoopbackHost(req.headers.host)) return sendJson(res, 421, { error: "loopback host required" });
    if (!isExpectedOrigin(origin)) return sendJson(res, 403, { error: "unexpected origin" });
    if (req.method === "OPTIONS") {
      if (!origin) return sendJson(res, 403, { error: "origin required" });
      res.writeHead(204, res.kyreiCors);
      res.end();
      return;
    }
    const headerToken = Array.isArray(req.headers["x-kyrei-gateway-token"])
      ? req.headers["x-kyrei-gateway-token"][0]
      : req.headers["x-kyrei-gateway-token"];
    const eventToken = path === "/api/events" ? url.searchParams.get("token") : null;
    if (path !== "/health" && !tokenMatches(headerToken) && !tokenMatches(eventToken)) {
      return sendJson(res, 401, { error: "gateway authentication required" });
    }

    try {
      if (req.method === "GET" && path === "/health") return sendJson(res, 200, { ok: true });

      if (req.method === "GET" && path === "/api/status") {
        return sendJson(res, 200, { ok: true, engine: "kyrei", ...publicConfig() });
      }

      if (path === "/api/config") {
        if (req.method === "GET") return sendJson(res, 200, publicConfig());
        if (req.method === "PUT") {
          const body = await readBody(req);
          const active = getActiveProvider(config);
          if (typeof body.provider === "string" && active) {
            ({ config } = upsertProvider(config, { ...active, baseURL: body.provider }, active.id));
          }
          const requestedProviderId = typeof body.activeProviderId === "string" ? body.activeProviderId : config.activeProviderId;
          const requestedModel = typeof body.activeModelId === "string"
            ? body.activeModelId
            : typeof body.model === "string"
              ? body.model
              : config.activeModelId;
          if (requestedProviderId || requestedModel) {
            config = selectProviderModel(config, requestedProviderId || config.activeProviderId, requestedModel);
          }
          if (typeof body.apiKey === "string" && body.apiKey.trim()) {
            secrets.providers[config.activeProviderId] = { apiKey: body.apiKey.trim() };
          }
          if (body.clearApiKey === true) delete secrets.providers[config.activeProviderId];
          if (typeof body.workspace === "string") config.workspace = body.workspace;
          // Engine tuning (permissions/roles/fallbackChain/budgets). Validated
          // engine-side by resolveEngineConfig (fail-open), so we store as-is.
          if (body.engine && typeof body.engine === "object") config.engine = body.engine;
          await saveConfig();
          return sendJson(res, 200, publicConfig());
        }
      }

      if (path === "/api/providers") {
        if (req.method === "GET") {
          const snapshot = publicConfig();
          return sendJson(res, 200, {
            providers: snapshot.providers,
            activeProviderId: snapshot.activeProviderId,
            activeModelId: snapshot.activeModelId,
          });
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          const input = body.provider && typeof body.provider === "object" ? body.provider : body;
          const id = createProviderId(String(input.name || input.id || "provider"), config.providers);
          const added = upsertProvider(config, { ...input, id }, id);
          config = added.config;
          if (typeof body.apiKey === "string" && body.apiKey.trim()) secrets.providers[added.provider.id] = { apiKey: body.apiKey.trim() };
          if (body.activate !== false) config = selectProviderModel(config, added.provider.id, input.model || added.provider.models[0]?.id);
          await saveConfig();
          return sendJson(res, 201, publicConfig());
        }
      }

      const providerMatch = path.match(/^\/api\/providers\/([^/]+)(\/secret)?$/);
      if (providerMatch) {
        const providerId = decodeURIComponent(providerMatch[1]);
        const secretPath = Boolean(providerMatch[2]);
        const existing = config.providers.find((provider) => provider.id === providerId);
        if (!existing) return sendJson(res, 404, { error: "provider not found" });
        if (secretPath) {
          if (req.method === "PUT") {
            const body = await readBody(req);
            const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
            if (!apiKey) return sendJson(res, 400, { error: "apiKey required" });
            secrets.providers[providerId] = { apiKey };
            await saveConfig();
            return sendJson(res, 200, publicConfig());
          }
          if (req.method === "DELETE") {
            delete secrets.providers[providerId];
            await saveConfig();
            return sendJson(res, 200, publicConfig());
          }
        }
        if (req.method === "PATCH") {
          const body = await readBody(req);
          const patch = body.provider && typeof body.provider === "object" ? body.provider : body;
          ({ config } = upsertProvider(config, { ...existing, ...patch, id: providerId }, providerId));
          await saveConfig();
          return sendJson(res, 200, publicConfig());
        }
        if (req.method === "DELETE") {
          try {
            config = removeProvider(config, providerId);
          } catch (error) {
            return sendJson(res, 409, { error: error.message });
          }
          delete secrets.providers[providerId];
          await saveConfig();
          return sendJson(res, 200, publicConfig());
        }
      }

      if (req.method === "POST" && path === "/api/choose-folder") {
        const folder = chooseFolder ? await chooseFolder() : "";
        if (folder) { config.workspace = folder; await saveConfig(); }
        return sendJson(res, 200, { folder: folder || "", ...publicConfig() });
      }

      if (path === "/api/sessions") {
        if (req.method === "GET") {
          const sessions = store.sessions.map(s => ({ ...s, status: runtimeStatus.get(s.id) || "idle" }));
          return sendJson(res, 200, { sessions });
        }
        if (req.method === "POST") {
          const id = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const now = new Date().toISOString();
          store.upsertSession({ id, title: "Новый диалог", createdAt: now, updatedAt: now });
          return sendJson(res, 200, { id });
        }
      }

      const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(\/messages)?$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        if (sessionMatch[2] === "/messages" && req.method === "GET") {
          return sendJson(res, 200, { session_id: id, messages: store.getMessages(id) });
        }
        if (req.method === "DELETE") { store.removeSession(id); return sendJson(res, 200, { ok: true }); }
        if (req.method === "PATCH") {
          const body = await readBody(req);
          store.upsertSession({ id, title: String(body.title || "").slice(0, 120), updatedAt: new Date().toISOString() });
          return sendJson(res, 200, { ok: true });
        }
      }

      if (req.method === "GET" && path === "/api/events") {
        const sessionId = url.searchParams.get("session") || "";
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          ...(res.kyreiCors ?? {}),
        });
        res.write(`data: ${JSON.stringify({ type: "gateway.ready" })}\n\n`);
        if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
        subscribers.get(sessionId).add(res);
        const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 25_000);
        req.on("close", () => { clearInterval(ping); subscribers.get(sessionId)?.delete(res); });
        return;
      }

      if (req.method === "POST" && path === "/api/prompt") {
        const body = await readBody(req);
        const sessionId = String(body.session || "");
        const text = String(body.text || "").trim();
        if (!sessionId || !text) return sendJson(res, 400, { error: "session and text required" });
        sendJson(res, 200, { status: "streaming" });
        void runPrompt(sessionId, text, body.modelParams);
        return;
      }

      if (req.method === "POST" && path === "/api/cancel") {
        const body = await readBody(req);
        if (body.session) {
          const sid = String(body.session);
          controllers.get(sid)?.abort();
        }
        return sendJson(res, 200, { ok: true });
      }

      // ── Workspace file explorer ──────────────────────────────────────
      if (req.method === "GET" && path === "/api/files") {
        if (!config.workspace) return sendJson(res, 200, { root: "", path: "", entries: [] });
        const rel = url.searchParams.get("path") || "";
        let abs;
        try {
          const mod = await getEngine();
          abs = typeof mod.safePath === "function" ? mod.safePath(config.workspace, rel || ".") : resolve(config.workspace, rel);
          if (typeof mod.safePath !== "function" && relative(config.workspace, abs).startsWith("..")) {
            return sendJson(res, 400, { error: "path outside workspace" });
          }
        } catch {
          return sendJson(res, 400, { error: "path outside workspace" });
        }
        try {
          const dirents = await readdir(abs, { withFileTypes: true });
          const entries = dirents
            .filter(d => !d.name.startsWith(".") || d.name === ".env.example")
            .map(d => ({ name: d.name, path: relative(config.workspace, resolve(abs, d.name)).replaceAll("\\", "/"), dir: d.isDirectory() }))
            .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
          return sendJson(res, 200, { root: config.workspace, path: relative(config.workspace, abs).replaceAll("\\", "/"), entries });
        } catch (e) {
          return sendJson(res, 404, { error: e.message });
        }
      }

      if (req.method === "GET" && path === "/api/file") {
        if (!config.workspace) return sendJson(res, 400, { error: "no workspace" });
        const rel = url.searchParams.get("path") || "";
        let abs;
        try {
          const mod = await getEngine();
          abs = typeof mod.safePath === "function" ? mod.safePath(config.workspace, rel || ".") : resolve(config.workspace, rel);
          if (typeof mod.safePath !== "function" && relative(config.workspace, abs).startsWith("..")) {
            return sendJson(res, 400, { error: "path outside workspace" });
          }
        } catch {
          return sendJson(res, 400, { error: "path outside workspace" });
        }
        try {
          const info = await stat(abs);
          if (info.size > 500_000) return sendJson(res, 200, { path: rel, content: "[файл слишком большой для предпросмотра]", truncated: true });
          const content = await readFile(abs, "utf8");
          return sendJson(res, 200, { path: rel, content });
        } catch (e) {
          return sendJson(res, 404, { error: e.message });
        }
      }

      // ── Model catalog (known engine models) ──────────────────────────
      if (req.method === "GET" && path === "/api/models") {
        let models = [];
        try {
          const mod = await getEngine();
          models = typeof mod.listModels === "function" ? mod.listModels() : [];
        } catch { /* engine bundle unavailable — degrade to manual entry */ }
        const configuredModels = config.providers.flatMap((provider) => provider.models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          provider: provider.id,
          providerName: provider.name,
          baseURL: provider.baseURL,
          limits: { contextWindow: 32_000, maxOutput: 4_096 },
          cost: { inputPerM: 0, outputPerM: 0 },
          caps: { tools: true, reasoning: false, streaming: true, vision: false },
        })));
        return sendJson(res, 200, {
          models: configuredModels.length ? configuredModels : models,
          current: config.activeModelId,
          provider: config.activeProviderId,
          activeProviderId: config.activeProviderId,
        });
      }

      // ── Path autocompletion for @-mentions (jail-safe) ───────────────
      if (req.method === "POST" && path === "/api/complete-path") {
        if (!config.workspace) return sendJson(res, 200, { entries: [] });
        const body = await readBody(req);
        const query = String(body.path || "");
        // Split into a directory part + a name prefix to filter on.
        const slash = Math.max(query.lastIndexOf("/"), query.lastIndexOf("\\"));
        const dirRel = slash >= 0 ? query.slice(0, slash) : "";
        const prefix = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase();
        try {
          const mod = await getEngine();
          // Validate the directory stays inside the workspace via the engine jail.
          const absDir = typeof mod.safePath === "function"
            ? mod.safePath(config.workspace, dirRel || ".")
            : resolve(config.workspace, dirRel || ".");
          const dirents = await readdir(absDir, { withFileTypes: true });
          const entries = dirents
            .filter(d => d.name.toLowerCase().startsWith(prefix) && (!d.name.startsWith(".") || prefix.startsWith(".")))
            .slice(0, 50)
            .map(d => {
              const rel = (dirRel ? dirRel.replace(/\\/g, "/") + "/" : "") + d.name;
              return { name: d.name, path: rel, dir: d.isDirectory() };
            })
            .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
          return sendJson(res, 200, { entries });
        } catch {
          return sendJson(res, 200, { entries: [] });
        }
      }

      sendJson(res, 404, { error: `Not found: ${req.method} ${path}` });
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  return new Promise((resolve, reject) => {
    const onError = error => {
      if (error.code === "EADDRINUSE" && server.listening === false) {
        server.removeListener("error", onError);
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, token: gatewayToken, close: () => server.close() }));
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(preferredPort, "127.0.0.1", () => resolve({ port: server.address().port, token: gatewayToken, close: () => server.close() }));
  });
}
