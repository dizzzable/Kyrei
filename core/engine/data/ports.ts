/**
 * Data-layer ports (requirements §10.3). The engine depends only on these
 * interfaces; concrete backends (SQLite default, Postgres optional) live behind
 * them, so the backend can be swapped by config without touching domain logic.
 *
 * SQLite (default) and Postgres backends implement these ports (see
 * `data/sqlite/*` and `data/postgres/*`). Note: the running gateway currently
 * persists sessions via `core/session-store.js`, not this engine data layer —
 * these stores are exercised by tests and available for future migration.
 */

import type { MessagePart } from "../types.js";

/**
 * Session row for the engine SessionStore (mirror + future cutover SoT).
 * Cutover fields (provider/model binding) are first-class; UI still writes JSON
 * until gateway APIs switch (see `.kyrei/plan/ROADMAP.md` A4).
 */
export interface SessionRecord {
  id: string;
  workspace?: string;
  title?: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "complete" | "interrupted" | "error" | "working";
  /** Bound model route (mirrored from gateway JSON session). */
  providerId?: string;
  modelId?: string;
  providerAccountId?: string;
  meta?: Record<string, unknown>;
  jsonlPath: string;
}

/**
 * Durable message row. Approvals live in `parts` (type: "approval").
 * clientId/pending/turnStatus mirror gateway JSON recovery fields.
 */
export interface StoredMessage {
  sessionId: string;
  seq: number;
  role: "system" | "user" | "assistant" | "tool";
  parts: MessagePart[];
  text?: string;
  toolCallId?: string;
  tokenEst?: number;
  compacted?: boolean;
  ccrHash?: string;
  createdAt: string;
  /** Gateway message id (`msg-…`) for stable re-sync / cutover. */
  clientId?: string;
  /** Incomplete assistant draft (crash recovery). */
  pending?: boolean;
  /** Gateway turn status on the assistant message. */
  turnStatus?: string;
  /** Model params captured for approval resume. */
  approvalModelParams?: Record<string, unknown>;
}

export interface SessionStore {
  createSession(rec: SessionRecord): Promise<void>;
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessions(opts?: { workspace?: string; limit?: number }): Promise<SessionRecord[]>;
  /**
   * Drop session row and all of its messages (FTS cleaned via delete triggers
   * on SQLite). Used by dual-write mirror when the JSON chat store deletes a session.
   */
  deleteSession(id: string): Promise<void>;
  appendMessage(msg: StoredMessage): Promise<number>;
  getMessages(sessionId: string, opts?: { fromSeq?: number }): Promise<StoredMessage[]>;
  /**
   * Remove all messages for a session without deleting the session row.
   * Enables true replace-on-sync for the dual-write mirror (avoids tail growth).
   */
  clearMessages(sessionId: string): Promise<void>;
  markCompacted(sessionId: string, seqRange: [number, number], ccrHash: string): Promise<void>;
  searchMessages(query: string, opts?: { sessionId?: string; limit?: number }): Promise<StoredMessage[]>;
}

export interface MemoryDoc {
  id: string;
  scope: "session" | "project" | "global";
  /**
   * Document class. `decision` / `plan` are projections of Tier A files into
   * the FTS index — files remain source of truth.
   */
  kind: "memory" | "notes" | "steering" | "agents" | "handoff" | "checkpoint" | "decision" | "plan";
  path: string;
  workspace?: string;
  title?: string;
  body: string;
  frontmatter?: Record<string, unknown>;
  contentHash: string;
  sourceRef?: string;
  updatedAt: string;
}

export interface MemoryStore {
  upsertDoc(doc: MemoryDoc): Promise<void>;
  getDoc(id: string): Promise<MemoryDoc | null>;
  listDocs(opts: {
    scope?: MemoryDoc["scope"];
    kind?: MemoryDoc["kind"];
    workspace?: string;
  }): Promise<MemoryDoc[]>;
  search(query: string, opts?: { scope?: MemoryDoc["scope"]; limit?: number }): Promise<MemoryDoc[]>;
  removeDoc(id: string): Promise<void>;
}

export interface VectorHit {
  ownerType: string;
  ownerId: string;
  chunkIndex: number;
  distance: number;
}

export interface VectorStore {
  upsert(
    rows: Array<{
      ownerType: string;
      ownerId: string;
      chunkIndex: number;
      model: string;
      embedding: Float32Array;
      contentHash: string;
    }>,
  ): Promise<void>;
  query(embedding: Float32Array, opts: { k: number; ownerType?: string }): Promise<VectorHit[]>;
  deleteByOwner(ownerType: string, ownerId: string): Promise<void>;
  hybridSearch(query: { text: string; embedding: Float32Array }, opts: { k: number }): Promise<VectorHit[]>;
}
