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

const SCHEMA_VERSION = 1;

export class SessionStore {
  constructor({ runtimeDir, maxMessages = 500 } = {}) {
    this.runtimeDir = runtimeDir;
    this.file = join(runtimeDir, "state.json");
    this.maxMessages = maxMessages;
    this.flushTimer = null;
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
    const next = {
      schemaVersion: SCHEMA_VERSION,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      messages: parsed.messages && typeof parsed.messages === "object" ? parsed.messages : {},
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
    const index = this.state.sessions.findIndex(item => item.id === session.id);
    if (index === -1) this.state.sessions.unshift(session);
    else this.state.sessions[index] = { ...this.state.sessions[index], ...session };
    this.touch();
    return this.getSession(session.id);
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
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await rename(tmp, this.file);
  }
}
