/**
 * Dual-write bridge: gateway JSON SessionStore (chat SoT) → engine SessionStore
 * (SQLite/Postgres FTS-ready mirror). Fail-open; never blocks chat durability.
 *
 * Ideal end-state before cutover: JSON remains authoritative for UI/approvals;
 * engine store accumulates searchable transcripts for migration and hybrid recall.
 *
 * Lifecycle (deeper dual-write):
 * - syncSession replaces messages (clear + re-append) so tails do not grow
 * - removeSession drops mirror rows when the JSON chat store deletes a session
 *
 * A4 schema: mirrors providerId/modelId/providerAccountId and approval parts +
 * pending/turnStatus for cutover readiness (write path still JSON).
 */

import type { MessagePart } from "../types.js";
import type { SessionRecord, SessionStore, StoredMessage } from "./ports.js";
import { redact } from "../security/secrets.js";

export interface GatewayMirrorSession {
  id: string;
  title?: string;
  workspace?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
  providerId?: string;
  modelId?: string;
  providerAccountId?: string;
  /** Soft-archive: messages stay searchable; UI hides from main list. */
  archived?: boolean;
  archivedAt?: string;
  /** User-created chat lineage (full-history branch or compact continuation). */
  parentSessionId?: string;
  rootSessionId?: string;
  forkedFromMessageId?: string;
  forkedAt?: string;
  lineageKind?: "branch" | "continuation";
  continuationSourceSessionId?: string;
  continuationPacketVersion?: 1;
  continuationCreatedAt?: string;
}

export interface GatewayMirrorMessage {
  id?: string;
  role?: string;
  text?: string;
  content?: string;
  at?: string;
  parts?: readonly unknown[];
  toolCallId?: string;
  pending?: boolean;
  turnStatus?: string;
  approvalModelParams?: Record<string, unknown>;
}

export interface SessionMirrorOptions {
  sessions: SessionStore;
  /** Absolute path label stored on SessionRecord.jsonlPath (not necessarily real JSONL). */
  jsonlPathPrefix?: string;
  sensitiveValues?: readonly string[];
}

function asRole(role: string | undefined): StoredMessage["role"] {
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") return role;
  return "assistant";
}

function asStatus(status: string | undefined): SessionRecord["status"] {
  if (
    status === "active"
    || status === "complete"
    || status === "interrupted"
    || status === "error"
    || status === "working"
  ) {
    return status;
  }
  // Gateway idle sessions map to active for the engine row.
  if (status === "idle") return "active";
  return "active";
}

function textFromParts(parts: readonly unknown[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      chunks.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const type = String(p.type ?? "");
    if ((type === "text" || type === "reasoning") && typeof p.text === "string") chunks.push(p.text);
    else if (type === "tool") {
      const name = typeof p.name === "string" ? p.name : "tool";
      const result = typeof p.result === "string" ? p.result.slice(0, 800) : "";
      chunks.push(result ? `[tool:${name}] ${result}` : `[tool:${name}]`);
    } else if (type === "approval") {
      const name = typeof p.name === "string" ? p.name : "tool";
      const status = typeof p.status === "string" ? p.status : "pending";
      chunks.push(`[approval:${name}:${status}]`);
    }
  }
  return chunks.join("\n").trim();
}

function toEngineParts(parts: readonly unknown[] | undefined, text: string): MessagePart[] {
  if (Array.isArray(parts) && parts.length) {
    const out: MessagePart[] = [];
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      const type = String(p.type ?? "");
      if (type === "text" && typeof p.text === "string") {
        out.push({ type: "text", text: p.text });
      } else if (type === "reasoning" && typeof p.text === "string") {
        out.push({ type: "reasoning", text: p.text });
      } else if (type === "tool") {
        out.push({
          type: "tool",
          toolCallId: String(p.toolCallId ?? p.id ?? "tool"),
          name: String(p.name ?? p.toolName ?? "tool"),
          args: p.args,
          result: typeof p.result === "string" ? p.result : undefined,
          running: p.running === true,
          error: typeof p.error === "string" ? p.error : undefined,
          awaitingApproval: p.awaitingApproval === true,
        });
      } else if (type === "approval") {
        const approvalId = typeof p.approvalId === "string" ? p.approvalId : "";
        const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : "";
        if (!approvalId || !toolCallId) continue;
        const status = p.status === "approved" || p.status === "denied" || p.status === "expired"
          ? p.status
          : "pending";
        out.push({
          type: "approval",
          approvalId,
          toolCallId,
          name: typeof p.name === "string" ? p.name : "tool",
          args: p.args,
          reason: typeof p.reason === "string" ? p.reason : "permission_rule_requires_confirmation",
          status,
          ...(typeof p.createdAt === "string" ? { createdAt: p.createdAt } : {}),
          ...(typeof p.expiresAt === "string" ? { expiresAt: p.expiresAt } : {}),
          ...(typeof p.resolvedAt === "string" ? { resolvedAt: p.resolvedAt } : {}),
          ...(typeof p.decisionReason === "string" ? { decisionReason: p.decisionReason } : {}),
          ...(typeof p.consumedAt === "string" ? { consumedAt: p.consumedAt } : {}),
        });
      }
    }
    if (out.length) return out;
  }
  return text ? [{ type: "text", text }] : [{ type: "text", text: "" }];
}

export function createSessionMirror(opts: SessionMirrorOptions) {
  const prefix = opts.jsonlPathPrefix ?? "gateway://sessions";

  async function mirrorSession(session: GatewayMirrorSession): Promise<void> {
    const existing = await opts.sessions.getSession(session.id);
    const rec: SessionRecord = {
      id: session.id,
      workspace: session.workspace,
      title: session.title,
      startedAt: session.createdAt ?? existing?.startedAt ?? new Date().toISOString(),
      status: asStatus(session.status ?? existing?.status ?? "active"),
      providerId: session.providerId ?? existing?.providerId,
      modelId: session.modelId ?? existing?.modelId,
      providerAccountId: session.providerAccountId ?? existing?.providerAccountId,
      jsonlPath: existing?.jsonlPath ?? `${prefix}/${session.id}.json`,
      meta: {
        ...(existing?.meta ?? {}),
        mirroredFrom: "gateway-json",
        updatedAt: session.updatedAt ?? new Date().toISOString(),
        schemaCutover: 2,
        // Soft-archive flag for hybrid memory / UI restore (messages not deleted).
        archived: session.archived === true,
        ...(session.archived === true && typeof session.archivedAt === "string"
          ? { archivedAt: session.archivedAt }
          : { archivedAt: undefined }),
        ...(typeof session.parentSessionId === "string" && session.parentSessionId
          ? { parentSessionId: session.parentSessionId }
          : { parentSessionId: undefined }),
        ...(typeof session.rootSessionId === "string" && session.rootSessionId
          ? { rootSessionId: session.rootSessionId }
          : { rootSessionId: undefined }),
        ...(typeof session.forkedFromMessageId === "string" && session.forkedFromMessageId
          ? { forkedFromMessageId: session.forkedFromMessageId }
          : { forkedFromMessageId: undefined }),
        ...(typeof session.forkedAt === "string" && session.forkedAt
          ? { forkedAt: session.forkedAt }
          : { forkedAt: undefined }),
        ...(session.lineageKind === "branch" || session.lineageKind === "continuation"
          ? { lineageKind: session.lineageKind }
          : { lineageKind: undefined }),
        ...(typeof session.continuationSourceSessionId === "string" && session.continuationSourceSessionId
          ? { continuationSourceSessionId: session.continuationSourceSessionId }
          : { continuationSourceSessionId: undefined }),
        ...(session.continuationPacketVersion === 1
          ? { continuationPacketVersion: 1 as const }
          : { continuationPacketVersion: undefined }),
        ...(typeof session.continuationCreatedAt === "string" && session.continuationCreatedAt
          ? { continuationCreatedAt: session.continuationCreatedAt }
          : { continuationCreatedAt: undefined }),
      },
    };
    if (existing) {
      await opts.sessions.updateSession(session.id, {
        workspace: rec.workspace,
        title: rec.title,
        status: rec.status,
        providerId: rec.providerId,
        modelId: rec.modelId,
        providerAccountId: rec.providerAccountId,
        meta: rec.meta,
      });
    } else {
      await opts.sessions.createSession(rec);
    }
  }

  async function mirrorMessage(
    sessionId: string,
    message: GatewayMirrorMessage,
    seq: number,
  ): Promise<void> {
    const rawText =
      (typeof message.text === "string" && message.text)
      || (typeof message.content === "string" && message.content)
      || (Array.isArray(message.parts) ? textFromParts(message.parts) : "");
    const text = redact(rawText, opts.sensitiveValues ?? []);
    const parts = toEngineParts(message.parts, text).map((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        return { ...part, text: redact(part.text, opts.sensitiveValues ?? []) };
      }
      if (part.type === "tool" && part.result) {
        return { ...part, result: redact(part.result, opts.sensitiveValues ?? []) };
      }
      return part;
    });
    const msg: StoredMessage = {
      sessionId,
      seq,
      role: asRole(message.role),
      parts,
      text,
      toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
      createdAt: message.at && Number.isFinite(Date.parse(message.at))
        ? message.at
        : new Date().toISOString(),
      clientId: typeof message.id === "string" ? message.id : undefined,
      pending: message.pending === true ? true : undefined,
      turnStatus: typeof message.turnStatus === "string" ? message.turnStatus : undefined,
      approvalModelParams:
        message.approvalModelParams && typeof message.approvalModelParams === "object"
          ? message.approvalModelParams
          : undefined,
    };
    await opts.sessions.appendMessage(msg);
  }

  /**
   * Full rebuild of one session in the mirror: upsert session meta, clear prior
   * messages, re-append from seq 1…n. Replace semantics keep FTS aligned with
   * the JSON SoT (no stale tail after shorter resync).
   */
  async function syncSession(
    session: GatewayMirrorSession,
    messages: readonly GatewayMirrorMessage[],
  ): Promise<{ messages: number }> {
    await mirrorSession(session);
    await opts.sessions.clearMessages(session.id);
    let n = 0;
    for (let i = 0; i < messages.length; i++) {
      await mirrorMessage(session.id, messages[i]!, i + 1);
      n += 1;
    }
    return { messages: n };
  }

  async function syncMany(
    items: ReadonlyArray<{ session: GatewayMirrorSession; messages: readonly GatewayMirrorMessage[] }>,
  ): Promise<{ sessions: number; messages: number }> {
    let sessions = 0;
    let messages = 0;
    for (const item of items) {
      const r = await syncSession(item.session, item.messages);
      sessions += 1;
      messages += r.messages;
    }
    return { sessions, messages };
  }

  /** Drop a mirrored session when the gateway JSON store removes it. */
  async function removeSession(sessionId: string): Promise<void> {
    await opts.sessions.deleteSession(sessionId);
  }

  return {
    mirrorSession,
    mirrorMessage,
    syncSession,
    syncMany,
    removeSession,
    searchMessages: (query: string, searchOpts?: { sessionId?: string; limit?: number }) =>
      opts.sessions.searchMessages(query, searchOpts),
    listSessions: (listOpts?: { workspace?: string; limit?: number }) =>
      opts.sessions.listSessions(listOpts),
  };
}

export type SessionMirror = ReturnType<typeof createSessionMirror>;
