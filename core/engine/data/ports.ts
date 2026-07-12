/**
 * Data-layer ports (requirements §10.3). The engine depends only on these
 * interfaces; concrete backends (SQLite default, Postgres optional) live behind
 * them, so the backend can be swapped by config without touching domain logic.
 *
 * Phase 0: interfaces only. Concrete SQLite implementation lands in Phase 5.
 */

import type { MessagePart } from "../types.js";

export interface SessionRecord {
  id: string;
  workspace?: string;
  title?: string;
  startedAt: string;
  endedAt?: string;
  status: "active" | "complete" | "interrupted" | "error";
  meta?: Record<string, unknown>;
  jsonlPath: string;
}

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
}

export interface SessionStore {
  createSession(rec: SessionRecord): Promise<void>;
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  listSessions(opts?: { workspace?: string; limit?: number }): Promise<SessionRecord[]>;
  appendMessage(msg: StoredMessage): Promise<number>;
  getMessages(sessionId: string, opts?: { fromSeq?: number }): Promise<StoredMessage[]>;
  markCompacted(sessionId: string, seqRange: [number, number], ccrHash: string): Promise<void>;
  searchMessages(query: string, opts?: { sessionId?: string; limit?: number }): Promise<StoredMessage[]>;
}

export interface MemoryDoc {
  id: string;
  scope: "session" | "project" | "global";
  kind: "memory" | "notes" | "steering" | "agents" | "handoff" | "checkpoint";
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
