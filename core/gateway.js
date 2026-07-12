import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { runKyreiChat } from "./kyrei-engine.js";
import { SessionStore } from "./session-store.js";

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
 *   POST /api/prompt   { session, text } -> run a turn (emits over SSE)
 *   POST /api/cancel   { session }       -> cancel the running turn
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...CORS });
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

export async function startGateway({ dataDir, chooseFolder, preferredPort = 8765 } = {}) {
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dataDir, "kyrei-config.json");

  let config = { provider: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini", workspace: "" };
  try { Object.assign(config, JSON.parse(await readFile(configPath, "utf8"))); } catch { /* first run */ }
  const saveConfig = () => writeFile(configPath, JSON.stringify(config, null, 2), "utf8").catch(() => {});

  const store = new SessionStore({ runtimeDir: dataDir });
  await store.load();

  // SSE subscribers + cancellation flags, keyed by session id.
  const subscribers = new Map(); // sessionId -> Set<res>
  const cancelled = new Set(); // sessionIds asked to stop (v1 engine)
  const controllers = new Map(); // sessionId -> AbortController (v2 engine)

  // v2 engine is a built ESM bundle; loaded lazily. It is now the default;
  // set KYREI_ENGINE=v1 to fall back to the legacy engine for one release.
  const useV2 = process.env.KYREI_ENGINE !== "v1";
  let engineV2 = null;
  const getEngineV2 = async () => {
    if (!engineV2) engineV2 = await import("./engine/.dist/index.mjs");
    return engineV2;
  };

  function emitTo(sessionId, event) {
    const set = subscribers.get(sessionId);
    if (!set) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) { try { res.write(frame); } catch { /* dropped */ } }
  }

  function publicConfig() {
    return { provider: config.provider, model: config.model, workspace: config.workspace, hasKey: Boolean(config.apiKey) };
  }

  function convoFor(sessionId) {
    return store.getMessages(sessionId)
      .filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: m.content }));
  }

  async function runPrompt(sessionId, text) {
    cancelled.delete(sessionId);
    const session = store.getSession(sessionId);
    if (!session) return;

    store.appendMessage(sessionId, { role: "user", content: text });
    if (!session.title || session.title === "Новый диалог") {
      store.upsertSession({ id: sessionId, title: text.slice(0, 48) + (text.length > 48 ? "…" : ""), updatedAt: new Date().toISOString() });
      emitTo(sessionId, { type: "session.title", payload: { session_id: sessionId, title: store.getSession(sessionId).title } });
    }

    const common = {
      emit: event => emitTo(sessionId, event),
      messages: convoFor(sessionId),
      providerBase: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      workspace: config.workspace,
    };

    let run;
    if (useV2) {
      const controller = new AbortController();
      controllers.set(sessionId, controller);
      const mod = await getEngineV2();
      run = mod.runKyreiChat({ ...common, abortSignal: controller.signal, config: config.engine });
    } else {
      run = runKyreiChat({ ...common, isCancelled: () => cancelled.has(sessionId) });
    }

    await run.then(({ text, parts }) => {
      store.appendMessage(sessionId, { role: "assistant", content: text, parts });
      store.upsertSession({ id: sessionId, updatedAt: new Date().toISOString() });
    }).catch(err => {
      emitTo(sessionId, { type: "error", payload: { message: err.message } });
    }).finally(() => {
      controllers.delete(sessionId);
    });
  }

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/health") return sendJson(res, 200, { ok: true });

      if (req.method === "GET" && path === "/api/status") {
        return sendJson(res, 200, { ok: true, engine: "kyrei", ...publicConfig() });
      }

      if (path === "/api/config") {
        if (req.method === "GET") return sendJson(res, 200, publicConfig());
        if (req.method === "PUT") {
          const body = await readBody(req);
          if (typeof body.provider === "string") config.provider = body.provider.trim();
          if (typeof body.apiKey === "string") config.apiKey = body.apiKey;
          if (typeof body.model === "string") config.model = body.model.trim();
          if (typeof body.workspace === "string") config.workspace = body.workspace;
          // Engine tuning (permissions/roles/fallbackChain/budgets). Validated
          // engine-side by resolveEngineConfig (fail-open), so we store as-is.
          if (body.engine && typeof body.engine === "object") config.engine = body.engine;
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
        if (req.method === "GET") return sendJson(res, 200, { sessions: store.sessions });
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
          ...CORS,
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
        void runPrompt(sessionId, text);
        return;
      }

      if (req.method === "POST" && path === "/api/cancel") {
        const body = await readBody(req);
        if (body.session) {
          const sid = String(body.session);
          cancelled.add(sid);
          controllers.get(sid)?.abort();
        }
        return sendJson(res, 200, { ok: true });
      }

      // ── Workspace file explorer ──────────────────────────────────────
      if (req.method === "GET" && path === "/api/files") {
        if (!config.workspace) return sendJson(res, 200, { root: "", path: "", entries: [] });
        const rel = url.searchParams.get("path") || "";
        const abs = resolve(config.workspace, rel);
        const within = relative(config.workspace, abs);
        if (within.startsWith("..")) return sendJson(res, 400, { error: "path outside workspace" });
        try {
          const dirents = await readdir(abs, { withFileTypes: true });
          const entries = dirents
            .filter(d => !d.name.startsWith(".") || d.name === ".env.example")
            .map(d => ({ name: d.name, path: relative(config.workspace, resolve(abs, d.name)).replaceAll("\\", "/"), dir: d.isDirectory() }))
            .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
          return sendJson(res, 200, { root: config.workspace, path: within.replaceAll("\\", "/"), entries });
        } catch (e) {
          return sendJson(res, 404, { error: e.message });
        }
      }

      if (req.method === "GET" && path === "/api/file") {
        if (!config.workspace) return sendJson(res, 400, { error: "no workspace" });
        const rel = url.searchParams.get("path") || "";
        const abs = resolve(config.workspace, rel);
        if (relative(config.workspace, abs).startsWith("..")) return sendJson(res, 400, { error: "path outside workspace" });
        try {
          const info = await stat(abs);
          if (info.size > 500_000) return sendJson(res, 200, { path: rel, content: "[файл слишком большой для предпросмотра]", truncated: true });
          const content = await readFile(abs, "utf8");
          return sendJson(res, 200, { path: rel, content });
        } catch (e) {
          return sendJson(res, 404, { error: e.message });
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
        server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() }));
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(preferredPort, "127.0.0.1", () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}
