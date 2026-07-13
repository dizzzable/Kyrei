import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Durable, append-safe state for Kyrei sessions and the active mission.
 *
 * The store keeps an in-memory snapshot and flushes it to a single JSON file
 * using an atomic write (temp file + rename) so a crash mid-write cannot leave
 * a half-serialized state on disk. It is intentionally schema-versioned so the
 * on-disk format can evolve without breaking older installs.
 */

const SCHEMA_VERSION = 4;

function boundedTarget(value, maxLength) {
  return typeof value === "string" && value.trim() && value.trim().length <= maxLength
    ? value.trim()
    : "";
}

function normalizeSessionRecord(value) {
  const source = value && typeof value === "object" ? value : {};
  const accountBindingWasSupplied = Object.prototype.hasOwnProperty.call(source, "providerAccountId");
  const { providerId: rawProviderId, modelId: rawModelId, providerAccountId: rawProviderAccountId, ...rest } = source;
  const providerId = boundedTarget(rawProviderId, 64);
  const modelId = boundedTarget(rawModelId, 512);
  const providerAccountId = boundedTarget(rawProviderAccountId, 64);
  return {
    ...rest,
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(providerAccountId && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerAccountId)
      ? { providerAccountId }
      : accountBindingWasSupplied
        ? { providerAccountId: undefined }
        : {}),
  };
}
const LEGACY_UNTITLED_TITLES = new Set(["Новый диалог", "New chat", "New session"]);

export class SessionStore {
  constructor({ runtimeDir, maxMessages = 500 } = {}) {
    this.runtimeDir = runtimeDir;
    this.file = join(runtimeDir, "state.json");
    this.maxMessages = maxMessages;
    this.flushTimer = null;
    this.flushPromise = Promise.resolve();
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      sessions: [],
      messages: {},
      mission: null,
      updatedAt: new Date().toISOString(),
    };
  }

  async load() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        this.state = this.migrate(parsed);
      }
    } catch {
      // No prior state (fresh workspace) — keep defaults.
    }
    return this.state;
  }

  migrate(parsed) {
    // Bring any older shape up to the current schema without losing data.
    const messages = parsed.messages && typeof parsed.messages === "object" ? parsed.messages : {};
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    const titleMigratedSessions = Number(parsed.schemaVersion ?? 1) < 2
      ? sessions.map(session => {
          const hasMessages = Array.isArray(messages[session.id]) && messages[session.id].length > 0;
          return !hasMessages && LEGACY_UNTITLED_TITLES.has(session.title)
            ? { ...session, title: "" }
            : session;
        })
      : sessions;
    const migratedSessions = titleMigratedSessions.map(normalizeSessionRecord);
    const next = {
      schemaVersion: SCHEMA_VERSION,
      sessions: migratedSessions,
      messages,
      mission: parsed.mission ?? null,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
    return next;
  }

  get sessions() { return this.state.sessions; }
  get mission() { return this.state.mission; }

  getSession(id) {
    return this.state.sessions.find(session => session.id === id) ?? null;
  }

  upsertSession(session) {
    const normalized = normalizeSessionRecord(session);
    const index = this.state.sessions.findIndex(item => item.id === normalized.id);
    if (index === -1) this.state.sessions.unshift(normalized);
    else this.state.sessions[index] = normalizeSessionRecord({ ...this.state.sessions[index], ...normalized });
    this.touch();
    return this.getSession(normalized.id);
  }

  removeSession(id) {
    this.state.sessions = this.state.sessions.filter(session => session.id !== id);
    delete this.state.messages[id];
    this.touch();
  }

  appendMessage(sessionId, message) {
    const list = this.state.messages[sessionId] ?? (this.state.messages[sessionId] = []);
    list.push({ ...message, at: message.at ?? new Date().toISOString() });
    if (list.length > this.maxMessages) list.splice(0, list.length - this.maxMessages);
    this.touch();
    return message;
  }

  getMessages(sessionId) {
    return this.state.messages[sessionId] ?? [];
  }

  setMission(mission) {
    this.state.mission = mission;
    this.touch();
    return mission;
  }

  snapshot() {
    return {
      schemaVersion: this.state.schemaVersion,
      sessions: this.state.sessions,
      mission: this.state.mission,
      updatedAt: this.state.updatedAt,
    };
  }

  touch() {
    this.state.updatedAt = new Date().toISOString();
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    // Debounce disk writes so bursts of events collapse into one flush.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, 150);
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
  }

  async flush() {
    const write = async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
      await rename(tmp, this.file);
    };
    const operation = this.flushPromise.then(write, write);
    this.flushPromise = operation.catch(() => {});
    return operation;
  }

  async close() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
