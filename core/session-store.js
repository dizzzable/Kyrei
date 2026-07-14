import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Durable, append-safe state for Kyrei sessions and the active mission.
 *
 * The store keeps an in-memory snapshot and flushes it to a single JSON file
 * using an atomic write (temp file + rename) so a crash mid-write cannot leave
 * a half-serialized state on disk. It is intentionally schema-versioned so the
 * on-disk format can evolve without breaking older installs.
 */

const SCHEMA_VERSION = 7;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_ID_RE = /^msg-[a-zA-Z0-9_-]{8,80}$/;

export class SessionApprovalError extends Error {
  constructor(code) {
    super(code);
    this.name = "SessionApprovalError";
    this.code = code;
  }
}

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

  resolveApproval(sessionId, approvalId, { approved, reason = "", now = new Date().toISOString() } = {}) {
    if (typeof approved !== "boolean") throw new SessionApprovalError("approval_decision_invalid");
    const found = this.findApproval(sessionId, approvalId);
    if (!found) throw new SessionApprovalError("approval_not_found");
    const decisionAt = approvalTimestamp(now, new Date().toISOString());
    const current = found.approval;
    if (current.consumedAt) throw new SessionApprovalError("approval_already_consumed");
    const expired = current.status === "expired"
      || Date.parse(current.expiresAt) <= Date.parse(decisionAt);
    // A denial has no side effect to guard, so its durable decision is also
    // its one-shot consumption point. This lets a signed continuation (or a
    // later user turn after a crash) carry the denial without stranding the
    // session behind an effect callback that will never run.
    if (expired) {
      const approval = {
        ...current,
        status: "expired",
        resolvedAt: current.resolvedAt ?? decisionAt,
        decisionReason: "approval_expired",
        consumedAt: current.consumedAt ?? decisionAt,
      };
      found.message.parts[found.partIndex] = approval;
      const ready = found.message.parts
        .filter(part => part?.type === "approval")
        .every(part => part.status !== "pending");
      this.touch();
      return {
        approval,
        messageId: found.message.id,
        ready,
        modelParams: found.message.approvalModelParams,
      };
    }
    const status = approved ? "approved" : "denied";
    if (current.status !== "pending" && current.status !== status) {
      throw new SessionApprovalError("approval_decision_conflict");
    }
    const approval = {
      ...current,
      status,
      resolvedAt: current.resolvedAt ?? decisionAt,
      ...(!approved ? { consumedAt: current.consumedAt ?? decisionAt } : {}),
      ...(reason ? { decisionReason: String(reason).slice(0, 500) } : {}),
    };
    found.message.parts[found.partIndex] = approval;
    const ready = found.message.parts
      .filter(part => part?.type === "approval")
      .every(part => part.status !== "pending");
    this.touch();
    return {
      approval,
      messageId: found.message.id,
      ready,
      modelParams: found.message.approvalModelParams,
    };
  }

  consumeApproval(sessionId, approvalId, now = new Date().toISOString()) {
    const found = this.findApproval(sessionId, approvalId);
    if (!found) throw new SessionApprovalError("approval_not_found");
    if (found.approval.consumedAt) return found.approval;
    if (found.approval.status !== "approved" && found.approval.status !== "denied" && found.approval.status !== "expired") {
      throw new SessionApprovalError("approval_not_resolved");
    }
    const approval = {
      ...found.approval,
      consumedAt: approvalTimestamp(now, new Date().toISOString()),
    };
    found.message.parts[found.partIndex] = approval;
    this.touch();
    return approval;
  }

  planRewind(sessionId, messageId) {
    const list = this.state.messages[sessionId] ?? [];
    const index = list.findIndex(message => message.id === messageId);
    if (index < 0 || list[index]?.role !== "user") return null;
    const removed = list.slice(index);
    const snapshotIds = removed.flatMap(message => Array.isArray(message.parts)
      ? message.parts.flatMap(part => part?.type === "tool" && typeof part.snapshotId === "string" ? [part.snapshotId] : [])
      : []);
    return {
      sessionId,
      messageId,
      index,
      expectedLength: list.length,
      originalMessages: list.slice(),
      originalSession: this.getSession(sessionId) ? { ...this.getSession(sessionId) } : null,
      draft: typeof list[index].content === "string" ? list[index].content : "",
      workspace: typeof list[index].workspace === "string" ? list[index].workspace : "",
      snapshotIds,
    };
  }

  commitRewind(plan) {
    if (!plan || typeof plan !== "object") return false;
    const list = this.state.messages[plan.sessionId] ?? [];
    if (
      list.length !== plan.expectedLength
      || list[plan.index]?.id !== plan.messageId
      || list[plan.index]?.role !== "user"
    ) return false;
    this.state.messages[plan.sessionId] = list.slice(0, plan.index);
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
