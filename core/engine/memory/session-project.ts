/**
 * Project chat session text into the rebuildable MemoryStore (scope=session).
 *
 * Gateway JSON SessionStore remains the chat SoT. This is a search projection
 * only — rebuildable, fail-open, never authoritative over transcript durability.
 * All projected text is secret-redacted before indexing.
 */

import { createHash } from "node:crypto";
import type { MemoryDoc, MemoryStore, VectorStore } from "../data/ports.js";
import { getEmbedAdapter, embedText, isZeroVector, splitTextForEmbedding } from "./embed-adapter.js";
import { redact } from "../security/secrets.js";
import { normalizeWorkspaceTag, sameWorkspaceTag } from "./workspace-id.js";

export interface ProjectableSessionMessage {
  id?: string;
  role?: string;
  text?: string;
  at?: string;
  /** Optional pre-flattened text from parts. */
  content?: string;
  /** Structured parts (gateway message shape). */
  parts?: readonly unknown[];
}

export interface ProjectableSession {
  id: string;
  title?: string;
  workspace?: string;
  messages: readonly ProjectableSessionMessage[];
}

export interface ProjectSessionsOptions {
  memory: MemoryStore;
  vectors?: VectorStore;
  workspace: string;
  /** Exact secret values to scrub (API keys from runtime). */
  sensitiveValues?: readonly string[];
  /** Max sessions to project (most recent first if caller sorts). */
  maxSessions?: number;
  /** Max messages per session (tail). */
  maxMessagesPerSession?: number;
  /** Max chars per message body. */
  maxCharsPerMessage?: number;
  /**
   * When true (default), drop prior projections for each session before upsert
   * so deleted/truncated tails do not leave ghost FTS rows.
   */
  pruneStale?: boolean;
}

export interface ProjectSessionsResult {
  upserted: number;
  vectorsUpserted: number;
  pruned: number;
  sessions: number;
}

function contentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 24);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Flatten gateway/UI message parts into searchable plain text. */
export function flattenMessageParts(parts: readonly unknown[] | undefined): string {
  if (!Array.isArray(parts) || parts.length === 0) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      chunks.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    const type = String(p.type ?? "");
    if (type === "text" || type === "reasoning") {
      if (typeof p.text === "string" && p.text.trim()) chunks.push(p.text);
      continue;
    }
    if (type === "tool") {
      // Tool I/O can be huge and noisy; keep a short searchable breadcrumb only.
      const name = typeof p.name === "string" ? p.name : typeof p.toolName === "string" ? p.toolName : "tool";
      const result = typeof p.result === "string" ? p.result : typeof p.output === "string" ? p.output : "";
      const snippet = result.trim() ? clip(result.trim(), 400) : "";
      chunks.push(snippet ? `[tool:${name}] ${snippet}` : `[tool:${name}]`);
      continue;
    }
  }
  return chunks.join("\n").trim();
}

export function messageText(m: ProjectableSessionMessage): string {
  if (typeof m.text === "string" && m.text.trim()) return m.text.trim();
  if (typeof m.content === "string" && m.content.trim()) return m.content.trim();
  const fromParts = flattenMessageParts(m.parts);
  if (fromParts) return fromParts;
  return "";
}

function scrub(text: string, sensitive: readonly string[] | undefined): string {
  return redact(text, sensitive ?? []);
}

async function pruneSessionDocs(
  memory: MemoryStore,
  sessionId: string,
  workspace: string,
): Promise<number> {
  let pruned = 0;
  try {
    const canonicalWorkspace = normalizeWorkspaceTag(workspace);
    const docs = await memory.listDocs({ scope: "session" });
    for (const d of docs) {
      if (!sameWorkspaceTag(d.workspace, canonicalWorkspace)) continue;
      const match =
        d.sourceRef === `session:${sessionId}`
        || d.id.startsWith(`sess:${sessionId}:`)
        || d.path.startsWith(`session/${sessionId}/`);
      if (!match) continue;
      await memory.removeDoc(d.id);
      pruned += 1;
    }
  } catch {
    /* fail-open */
  }
  return pruned;
}

/**
 * Upsert session message projections. Safe to call repeatedly; ids are stable
 * per session+message id (or seq fallback).
 */
export async function projectSessionsIntoMemory(
  sessions: readonly ProjectableSession[],
  opts: ProjectSessionsOptions,
): Promise<ProjectSessionsResult> {
  // A caller that asks for a full rebuild must get the complete snapshot. The
  // previous implicit 40-session limit made Settings claim success while
  // silently omitting older chats.
  const maxSessions = opts.maxSessions ?? sessions.length;
  const maxMessages = opts.maxMessagesPerSession ?? 80;
  const maxChars = opts.maxCharsPerMessage ?? 4_000;
  const pruneStale = opts.pruneStale !== false;
  const workspace = normalizeWorkspaceTag(opts.workspace);
  let upserted = 0;
  let vectorsUpserted = 0;
  let pruned = 0;
  const pendingVectors: Array<{
    ownerType: string;
    ownerId: string;
    chunkIndex: number;
    model: string;
    embedding: Float32Array;
    contentHash: string;
  }> = [];

  const slice = sessions.slice(0, maxSessions);
  for (const session of slice) {
    if (pruneStale) {
      pruned += await pruneSessionDocs(opts.memory, session.id, workspace);
    }
    const msgs = session.messages
      .filter((m) => {
        const role = String(m.role ?? "");
        return role === "user" || role === "assistant" || role === "system";
      })
      .map((m) => ({ ...m, text: scrub(messageText(m), opts.sensitiveValues) }))
      .filter((m) => m.text && m.text.length > 0 && m.text !== "[REDACTED]");

    const tail = msgs.slice(Math.max(0, msgs.length - maxMessages));
    for (let i = 0; i < tail.length; i++) {
      const m = tail[i]!;
      const body = clip(m.text!, maxChars);
      const msgKey = m.id?.trim() || `seq-${i}`;
      const id = `sess:${session.id}:msg:${msgKey}`.slice(0, 200);
      const doc: MemoryDoc = {
        id,
        scope: "session",
        kind: "notes",
        path: `session/${session.id}/${msgKey}`,
        workspace,
        title: scrub(`${session.title || session.id} · ${m.role ?? "msg"}`, opts.sensitiveValues),
        body: `[${m.role ?? "message"}] ${body}`,
        contentHash: contentHash(body),
        sourceRef: `session:${session.id}`,
        updatedAt: m.at && Number.isFinite(Date.parse(m.at)) ? m.at : new Date().toISOString(),
        frontmatter: {
          sessionId: session.id,
          role: m.role,
          messageId: msgKey,
        },
      };
      await opts.memory.upsertDoc(doc);
      upserted += 1;
      if (opts.vectors) {
        try {
          await opts.vectors.deleteByOwner("memory_doc", id);
        } catch {
          /* fail-open */
        }
        try {
          const chunks = splitTextForEmbedding(doc.body);
          for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
            const embedding = await embedText(`${doc.title}\n${chunks[chunkIndex]!}`.trim());
            if (!isZeroVector(embedding)) {
              pendingVectors.push({
                ownerType: "memory_doc",
                ownerId: id,
                chunkIndex,
                model: getEmbedAdapter().modelId,
                embedding,
                contentHash: doc.contentHash,
              });
            }
          }
        } catch {
          /* fail-open */
        }
      }
    }
  }

  if (opts.vectors && pendingVectors.length) {
    const batch = 64;
    for (let i = 0; i < pendingVectors.length; i += batch) {
      const chunk = pendingVectors.slice(i, i + batch);
      await opts.vectors.upsert(chunk);
      vectorsUpserted += chunk.length;
    }
  }

  return { upserted, vectorsUpserted, pruned, sessions: slice.length };
}

/** Extract searchable snippets from in-flight model messages (current turn). */
export function snippetsFromModelMessages(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
  opts: { maxMessages?: number; maxChars?: number; sensitiveValues?: readonly string[] } = {},
): Array<{ role: string; text: string }> {
  const maxMessages = opts.maxMessages ?? 24;
  const maxChars = opts.maxChars ?? 2_000;
  const out: Array<{ role: string; text: string }> = [];
  for (let i = messages.length - 1; i >= 0 && out.length < maxMessages; i--) {
    const m = messages[i]!;
    const role = String(m.role ?? "");
    if (role !== "user" && role !== "assistant") continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object" && "type" in p) {
            const t = (p as { type: string; text?: string }).type;
            if (t === "text" || t === "reasoning") {
              return String((p as { text?: string }).text ?? "");
            }
          }
          return "";
        })
        .join("\n");
    }
    text = scrub(text.trim(), opts.sensitiveValues);
    if (!text || text === "[REDACTED]") continue;
    out.push({ role, text: text.length <= maxChars ? text : `${text.slice(0, maxChars)}…` });
  }
  return out.reverse();
}
