import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  APPROVAL_TTL_MS,
  SessionMutationError,
  resolveApprovalInMessages,
  consumeApprovalInMessages,
  planRewindInMessages,
  commitRewindInMessages,
} from "./session-mutations.js";

/**
 * Durable, append-safe state for Kyrei sessions and the active mission.
 *
 * The store keeps an in-memory snapshot and flushes it to a single JSON file
 * using an atomic write (temp file + rename) so a crash mid-write cannot leave
 * a half-serialized state on disk. It is intentionally schema-versioned so the
 * on-disk format can evolve without breaking older installs.
 */

const SCHEMA_VERSION = 7;
const MESSAGE_ID_RE = /^msg-[a-zA-Z0-9_-]{8,80}$/;

export class SessionApprovalError extends Error {
  constructor(code) {
    super(code);
    this.name = "SessionApprovalError";
    this.code = code;
  }
}

export { SessionMutationError, APPROVAL_TTL_MS };

export function isSessionMessageId(value) {
  return typeof value === "string" && MESSAGE_ID_RE.test(value);
}

function normalizedMessageId(value, sessionId, index) {
  if (isSessionMessageId(value)) return value;
  const safeSession = String(sessionId ?? "session").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "session";
  return `msg-legacy-${safeSession}-${index}`;
}

function normalizeStoredMessage(value, sessionId, index) {
  const source = value && typeof value === "object" ? value : {};
  const at = typeof source.at === "string" && Number.isFinite(Date.parse(source.at))
    ? source.at
    : new Date().toISOString();
  const parts = Array.isArray(source.parts)
    ? source.parts.map(part => normalizeApprovalPart(part, at))
    : source.parts;
  return {
    ...source,
    id: normalizedMessageId(source.id, sessionId, index),
    at,
    ...(Array.isArray(parts) ? { parts } : {}),
  };
}

function recoverInterruptedDraft(message) {
  if (
    message?.role !== "assistant"
    || (message.pending !== true && message.turnStatus !== "streaming")
  ) return message;
  const parts = Array.isArray(message.parts)
    ? message.parts.map(part => part?.type === "tool" && part.running === true
      ? {
          ...part,
          running: false,
          error: typeof part.error === "string" && part.error ? part.error : "tool_interrupted",
          progress: undefined,
        }
      : part)
    : message.parts;
  return {
    ...message,
    pending: false,
    turnStatus: "interrupted",
    ...(Array.isArray(parts) ? { parts } : {}),
  };
}

function approvalIdentifier(value) {
  return typeof value === "string" && value.trim().length >= 8 && value.trim().length <= 200
    ? value.trim()
    : "";
}

function approvalTimestamp(value, fallback) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function normalizeApprovalPart(value, messageAt) {
  if (!value || typeof value !== "object" || value.type !== "approval") return value;
  const approvalId = approvalIdentifier(value.approvalId);
  const toolCallId = approvalIdentifier(value.toolCallId);
  if (!approvalId || !toolCallId) return value;
  const createdAt = approvalTimestamp(value.createdAt, messageAt);
  const expiresAt = approvalTimestamp(
    value.expiresAt,
    new Date(Date.parse(createdAt) + APPROVAL_TTL_MS).toISOString(),
  );
  const status = ["pending", "approved", "denied", "expired"].includes(value.status)
    ? value.status
    : "pending";
  const resolvedAt = value.resolvedAt
    ? approvalTimestamp(value.resolvedAt, createdAt)
    : undefined;
  const consumedAt = value.consumedAt
    ? approvalTimestamp(value.consumedAt, resolvedAt ?? createdAt)
    : status === "denied" || status === "expired"
      ? resolvedAt ?? createdAt
      : undefined;
  return {
    ...value,
    approvalId,
    toolCallId,
    name: typeof value.name === "string" ? value.name.slice(0, 160) : "tool",
    reason: typeof value.reason === "string" ? value.reason.slice(0, 500) : "permission_rule_requires_confirmation",
    status,
    createdAt,
    expiresAt,
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(consumedAt ? { consumedAt } : {}),
    ...(typeof value.decisionReason === "string" ? { decisionReason: value.decisionReason.slice(0, 500) } : {}),
  };
}

function normalizedMessagesBySession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([sessionId, messages]) => [
    sessionId,
    Array.isArray(messages)
      ? messages.map((message, index) => recoverInterruptedDraft(
          normalizeStoredMessage(message, sessionId, index),
        ))
      : [],
  ]));
}

function nextMessageId() {
  return `msg-${randomUUID()}`;
}

function boundedTarget(value, maxLength) {
  return typeof value === "string" && value.trim() && value.trim().length <= maxLength
    ? value.trim()
    : "";
}

function boundedSessionId(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const id = value.trim().slice(0, 128);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) ? id : "";
}

function normalizeSessionRecord(value) {
  const source = value && typeof value === "object" ? value : {};
  const accountBindingWasSupplied = Object.prototype.hasOwnProperty.call(source, "providerAccountId");
  const {
    providerId: rawProviderId,
    modelId: rawModelId,
    providerAccountId: rawProviderAccountId,
    parentSessionId: rawParent,
    rootSessionId: rawRoot,
    forkedFromMessageId: rawForkMsg,
    forkedAt: rawForkedAt,
    lineageKind: rawLineageKind,
    codingMode: rawCodingMode,
    ...rest
  } = source;
  const providerId = boundedTarget(rawProviderId, 64);
  const modelId = boundedTarget(rawModelId, 512);
  const codingMode = rawCodingMode === "auto"
    || rawCodingMode === "plan"
    || rawCodingMode === "build"
    || rawCodingMode === "polish"
    || rawCodingMode === "deepreep"
    || rawCodingMode === "balanced"
    ? (rawCodingMode === "balanced" ? "auto" : rawCodingMode)
    : undefined;
  const providerAccountId = boundedTarget(rawProviderAccountId, 64);
  const archived = source.archived === true;
  const archivedAt = typeof source.archivedAt === "string" && Number.isFinite(Date.parse(source.archivedAt))
    ? source.archivedAt
    : undefined;
  const parentSessionId = boundedSessionId(rawParent);
  const rootSessionId = boundedSessionId(rawRoot);
  const forkedFromMessageId = typeof rawForkMsg === "string" && isSessionMessageId(rawForkMsg)
    ? rawForkMsg
    : (typeof rawForkMsg === "string" && rawForkMsg.startsWith("msg-") ? rawForkMsg.slice(0, 80) : "");
  const forkedAt = typeof rawForkedAt === "string" && Number.isFinite(Date.parse(rawForkedAt))
    ? rawForkedAt
    : undefined;
  const lineageKind = rawLineageKind === "branch" ? "branch" : undefined;
  // Drop stale archive/lineage fields from rest so clears work.
  const {
    archived: _a,
    archivedAt: _b,
    parentSessionId: _p,
    rootSessionId: _r,
    forkedFromMessageId: _f,
    forkedAt: _fa,
    lineageKind: _lk,
    codingMode: _cm,
    ...cleanRest
  } = rest;
  return {
    ...cleanRest,
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(providerAccountId && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(providerAccountId)
      ? { providerAccountId }
      : accountBindingWasSupplied
        ? { providerAccountId: undefined }
        : {}),
    // Soft-archive: hide from sidebar but keep messages for hybrid memory / restore.
    ...(archived
      ? { archived: true, archivedAt: archivedAt ?? new Date().toISOString() }
      : { archived: false }),
    // User fork lineage (never used for subagents / compression children).
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(rootSessionId ? { rootSessionId } : {}),
    ...(forkedFromMessageId ? { forkedFromMessageId } : {}),
    ...(forkedAt ? { forkedAt } : {}),
    ...(lineageKind ? { lineageKind } : {}),
    ...(codingMode ? { codingMode } : {}),
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
    const rawMessages = parsed.messages && typeof parsed.messages === "object" ? parsed.messages : {};
    const messages = normalizedMessagesBySession(rawMessages);
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

  /**
   * Soft-archive (or restore). Messages stay on disk for FTS / hybrid memory.
   * @param {string} id
   * @param {boolean} archived
   */
  setSessionArchived(id, archived) {
    const current = this.getSession(id);
    if (!current) return null;
    if (archived) {
      return this.upsertSession({
        ...current,
        archived: true,
        archivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    const { archivedAt: _drop, ...rest } = current;
    return this.upsertSession({
      ...rest,
      archived: false,
      archivedAt: undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Active (non-archived) sessions for the sidebar. */
  listActiveSessions() {
    return this.state.sessions.filter((s) => s?.archived !== true);
  }

  /** Soft-archived sessions (messages retained). */
  listArchivedSessions() {
    return this.state.sessions.filter((s) => s?.archived === true);
  }

  /**
   * Fork a chat into a new session (full copy or prefix through messageId).
   * Parent messages are never modified. LineageKind is always "branch".
   * @param {string} parentId
   * @param {{ messageId?: string, newId?: string, title?: string }} [opts]
   */
  forkSession(parentId, opts = {}) {
    const parent = this.getSession(parentId);
    if (!parent) return null;
    const messages = this.getMessages(parentId);
    let prefix = messages;
    const messageId = typeof opts.messageId === "string" ? opts.messageId.trim() : "";
    if (messageId) {
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx < 0) {
        const err = new Error("fork_message_not_found");
        err.code = "fork_message_not_found";
        throw err;
      }
      if (messages[idx]?.role !== "user") {
        const err = new Error("fork_message_not_user");
        err.code = "fork_message_not_user";
        throw err;
      }
      prefix = messages.slice(0, idx + 1);
    }
    const newId = typeof opts.newId === "string" && opts.newId.trim()
      ? opts.newId.trim()
      : `sess-${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    if (this.getSession(newId)) {
      const err = new Error("fork_id_exists");
      err.code = "fork_id_exists";
      throw err;
    }
    const now = new Date().toISOString();
    const rootSessionId = parent.rootSessionId || parent.id;
    const parentTitle = typeof parent.title === "string" ? parent.title.trim() : "";
    // Keep title locale-neutral (badge shows fork). Optional explicit title from caller.
    const title = typeof opts.title === "string" && opts.title.trim()
      ? opts.title.trim().slice(0, 200)
      : parentTitle.slice(0, 200);
    const child = this.upsertSession({
      id: newId,
      title,
      source: parent.source === "cron" || parent.source === "import" || parent.source === "messaging"
        ? parent.source
        : "chat",
      createdAt: now,
      updatedAt: now,
      ...(parent.providerId ? { providerId: parent.providerId } : {}),
      ...(parent.modelId ? { modelId: parent.modelId } : {}),
      ...(parent.providerAccountId ? { providerAccountId: parent.providerAccountId } : {}),
      ...(parent.codingMode ? { codingMode: parent.codingMode } : {}),
      archived: false,
      parentSessionId: parent.id,
      rootSessionId,
      lineageKind: "branch",
      forkedAt: now,
      ...(messageId ? { forkedFromMessageId: messageId } : {}),
    });
    this.state.messages[newId] = [];
    for (const msg of prefix) {
      const { id: _oldId, pending: _pending, turnStatus: _ts, ...rest } =
        msg && typeof msg === "object" ? msg : {};
      // Drop live turn / pending approval state so the fork is a clean snapshot.
      let parts = Array.isArray(rest.parts) ? rest.parts : undefined;
      if (parts) {
        parts = parts.map((part) => {
          if (!part || typeof part !== "object") return part;
          if (part.type === "approval" && part.status === "pending") {
            return {
              ...part,
              status: "denied",
              deniedReason: "forked_session",
              resolvedAt: now,
            };
          }
          return part;
        });
      }
      this.appendMessage(newId, {
        ...rest,
        ...(parts ? { parts } : {}),
        pending: false,
        // Fresh ids so exports/approvals never collide across sessions.
        id: nextMessageId(),
      });
    }
    this.touch();
    return { session: child, messageCount: this.getMessages(newId).length };
  }

  appendMessage(sessionId, message) {
    const list = this.state.messages[sessionId] ?? (this.state.messages[sessionId] = []);
    const requestedId = isSessionMessageId(message?.id)
      ? message.id
      : nextMessageId();
    const id = list.some(candidate => candidate.id === requestedId) ? nextMessageId() : requestedId;
    const at = typeof message?.at === "string" && Number.isFinite(Date.parse(message.at))
      ? message.at
      : new Date().toISOString();
    const stored = {
      ...message,
      id,
      at,
      ...(Array.isArray(message?.parts)
        ? { parts: message.parts.map(part => normalizeApprovalPart(part, at)) }
        : {}),
    };
    list.push(stored);
    if (list.length > this.maxMessages) list.splice(0, list.length - this.maxMessages);
    this.touch();
    return stored;
  }

  getMessages(sessionId) {
    return this.state.messages[sessionId] ?? [];
  }

  getMessage(sessionId, messageId) {
    return (this.state.messages[sessionId] ?? []).find(message => message.id === messageId) ?? null;
  }

  updateMessage(sessionId, messageId, patch) {
    const list = this.state.messages[sessionId] ?? [];
    const index = list.findIndex(message => message.id === messageId);
    if (index < 0) return null;
    const current = list[index];
    const next = typeof patch === "function" ? patch(current) : patch;
    if (!next || typeof next !== "object") return current;
    const stored = normalizeStoredMessage({ ...current, ...next, id: current.id }, sessionId, index);
    list[index] = stored;
    this.touch();
    return stored;
  }

  removeMessage(sessionId, messageId) {
    const list = this.state.messages[sessionId] ?? [];
    const index = list.findIndex(message => message.id === messageId);
    if (index < 0) return false;
    list.splice(index, 1);
    this.touch();
    return true;
  }

  findApproval(sessionId, approvalId) {
    const list = this.state.messages[sessionId] ?? [];
    for (let messageIndex = list.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = list[messageIndex];
      if (!Array.isArray(message?.parts)) continue;
      const partIndex = message.parts.findIndex(part => part?.type === "approval" && part.approvalId === approvalId);
      if (partIndex >= 0) return { message, messageIndex, partIndex, approval: message.parts[partIndex] };
    }
    return null;
  }

  getApproval(sessionId, approvalId) {
    return this.findApproval(sessionId, approvalId)?.approval ?? null;
  }

  hasUnconsumedApprovals(sessionId) {
    return (this.state.messages[sessionId] ?? []).some(message => Array.isArray(message?.parts)
      && message.parts.some(part => part?.type === "approval" && !part.consumedAt));
  }

  /**
   * Replace the full message list for a session (used by engine-primary write-back).
   */
  replaceMessages(sessionId, messages) {
    this.state.messages[sessionId] = Array.isArray(messages)
      ? messages.map((message, index) => normalizeStoredMessage(message, sessionId, index))
      : [];
    this.touch();
    return this.state.messages[sessionId];
  }

  resolveApproval(sessionId, approvalId, { approved, reason = "", now = new Date().toISOString() } = {}) {
    try {
      const list = this.state.messages[sessionId] ?? [];
      const result = resolveApprovalInMessages(list, approvalId, { approved, reason, now });
      this.state.messages[sessionId] = result.messages;
      this.touch();
      return {
        approval: result.approval,
        messageId: result.messageId,
        ready: result.ready,
        modelParams: result.modelParams,
      };
    } catch (error) {
      if (error instanceof SessionMutationError) throw new SessionApprovalError(error.code);
      throw error;
    }
  }

  consumeApproval(sessionId, approvalId, now = new Date().toISOString()) {
    try {
      const list = this.state.messages[sessionId] ?? [];
      const result = consumeApprovalInMessages(list, approvalId, now);
      this.state.messages[sessionId] = result.messages;
      this.touch();
      return result.approval;
    } catch (error) {
      if (error instanceof SessionMutationError) throw new SessionApprovalError(error.code);
      throw error;
    }
  }

  planRewind(sessionId, messageId) {
    const list = this.state.messages[sessionId] ?? [];
    const plan = planRewindInMessages(list, messageId, this.getSession(sessionId));
    if (!plan) return null;
    return { ...plan, sessionId };
  }

  commitRewind(plan) {
    if (!plan || typeof plan !== "object") return false;
    const list = this.state.messages[plan.sessionId] ?? [];
    const result = commitRewindInMessages(list, plan);
    if (!result.ok) return false;
    this.state.messages[plan.sessionId] = result.messages;
    const session = this.getSession(plan.sessionId);
    if (session) this.upsertSession({ id: plan.sessionId, updatedAt: new Date().toISOString() });
    else this.touch();
    return true;
  }

  rollbackRewind(plan) {
    if (!plan || typeof plan !== "object" || !Array.isArray(plan.originalMessages)) return false;
    const current = this.state.messages[plan.sessionId] ?? [];
    const expectedPrefix = plan.originalMessages.slice(0, plan.index);
    if (
      current.length !== expectedPrefix.length
      || current.some((message, index) => message.id !== expectedPrefix[index]?.id)
    ) return false;
    this.state.messages[plan.sessionId] = plan.originalMessages.slice();
    const sessionIndex = this.state.sessions.findIndex(session => session.id === plan.sessionId);
    if (plan.originalSession && sessionIndex >= 0) {
      this.state.sessions[sessionIndex] = { ...plan.originalSession };
    }
    this.touch();
    return true;
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
    // Cancel debounced write so we don't race a second flush on the same tmp name.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const write = async () => {
      await mkdir(dirname(this.file), { recursive: true });
      // Unique temp name (Windows-safe): concurrent flushes must not share state.json.tmp.
      const tmp = `${this.file}.${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 12)}.tmp`;
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
