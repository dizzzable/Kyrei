import type { SessionStore, SessionRecord, StoredMessage } from "../ports.js";
import type { DB } from "./open.js";

function partsText(parts: StoredMessage["parts"]): string {
  return parts
    .map((p) => (p.type === "text" || p.type === "reasoning" ? p.text : p.type === "tool" ? (p.result ?? "") : ""))
    .join("\n")
    .trim();
}

function ftsQuery(q: string): string {
  const cleaned = q.replace(/["*]/g, " ").trim();
  return cleaned ? `"${cleaned}"` : '""';
}

interface SessionRow {
  id: string;
  workspace: string | null;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  meta_json: string | null;
  jsonl_path: string;
  updated_at: string;
}
interface MsgRow {
  session_id: string;
  seq: number;
  role: string;
  parts_json: string;
  text: string | null;
  tool_call_id: string | null;
  token_est: number | null;
  compacted: number;
  ccr_hash: string | null;
  created_at: string;
}

function toRecord(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    workspace: r.workspace ?? undefined,
    title: r.title ?? undefined,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? undefined,
    status: r.status as SessionRecord["status"],
    meta: r.meta_json ? (JSON.parse(r.meta_json) as Record<string, unknown>) : undefined,
    jsonlPath: r.jsonl_path,
  };
}
function toMessage(r: MsgRow): StoredMessage {
  return {
    sessionId: r.session_id,
    seq: r.seq,
    role: r.role as StoredMessage["role"],
    parts: JSON.parse(r.parts_json) as StoredMessage["parts"],
    text: r.text ?? undefined,
    toolCallId: r.tool_call_id ?? undefined,
    tokenEst: r.token_est ?? undefined,
    compacted: Boolean(r.compacted),
    ccrHash: r.ccr_hash ?? undefined,
    createdAt: r.created_at,
  };
}

export function createSqliteSessionStore(db: DB): SessionStore {
  return {
    async createSession(rec) {
      db.prepare(
        `INSERT OR REPLACE INTO sessions(id,workspace,title,started_at,ended_at,status,meta_json,jsonl_path,updated_at)
         VALUES (@id,@workspace,@title,@started_at,@ended_at,@status,@meta_json,@jsonl_path,@updated_at)`,
      ).run({
        id: rec.id,
        workspace: rec.workspace ?? null,
        title: rec.title ?? null,
        started_at: rec.startedAt,
        ended_at: rec.endedAt ?? null,
        status: rec.status,
        meta_json: rec.meta ? JSON.stringify(rec.meta) : null,
        jsonl_path: rec.jsonlPath,
        updated_at: new Date().toISOString(),
      });
    },

    async updateSession(id, patch) {
      const cur = (db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionRow | undefined) ?? null;
      if (!cur) return;
      const merged = { ...toRecord(cur), ...patch, id };
      db.prepare(
        `UPDATE sessions SET workspace=@workspace,title=@title,ended_at=@ended_at,status=@status,meta_json=@meta_json,updated_at=@updated_at WHERE id=@id`,
      ).run({
        id,
        workspace: merged.workspace ?? null,
        title: merged.title ?? null,
        ended_at: merged.endedAt ?? null,
        status: merged.status,
        meta_json: merged.meta ? JSON.stringify(merged.meta) : null,
        updated_at: new Date().toISOString(),
      });
    },

    async getSession(id) {
      const r = db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionRow | undefined;
      return r ? toRecord(r) : null;
    },

    async listSessions(opts) {
      const rows = (
        opts?.workspace
          ? db.prepare("SELECT * FROM sessions WHERE workspace=? ORDER BY started_at DESC").all(opts.workspace)
          : db.prepare("SELECT * FROM sessions ORDER BY started_at DESC").all()
      ) as SessionRow[];
      const list = rows.map(toRecord);
      return opts?.limit ? list.slice(0, opts.limit) : list;
    },

    async appendMessage(msg) {
      db.prepare(
        `INSERT OR REPLACE INTO messages(session_id,seq,role,parts_json,text,tool_call_id,token_est,compacted,ccr_hash,created_at)
         VALUES (@session_id,@seq,@role,@parts_json,@text,@tool_call_id,@token_est,@compacted,@ccr_hash,@created_at)`,
      ).run({
        session_id: msg.sessionId,
        seq: msg.seq,
        role: msg.role,
        parts_json: JSON.stringify(msg.parts),
        text: msg.text ?? partsText(msg.parts),
        tool_call_id: msg.toolCallId ?? null,
        token_est: msg.tokenEst ?? null,
        compacted: msg.compacted ? 1 : 0,
        ccr_hash: msg.ccrHash ?? null,
        created_at: msg.createdAt,
      });
      return msg.seq;
    },

    async getMessages(sessionId, opts) {
      const rows = (
        opts?.fromSeq != null
          ? db.prepare("SELECT * FROM messages WHERE session_id=? AND seq>=? ORDER BY seq").all(sessionId, opts.fromSeq)
          : db.prepare("SELECT * FROM messages WHERE session_id=? ORDER BY seq").all(sessionId)
      ) as MsgRow[];
      return rows.map(toMessage);
    },

    async markCompacted(sessionId, seqRange, ccrHash) {
      db.prepare("UPDATE messages SET compacted=1, ccr_hash=? WHERE session_id=? AND seq BETWEEN ? AND ?").run(
        ccrHash,
        sessionId,
        seqRange[0],
        seqRange[1],
      );
    },

    async searchMessages(query, opts) {
      const limit = opts?.limit ?? 50;
      const rows = (
        opts?.sessionId
          ? db
              .prepare(
                "SELECT m.* FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE messages_fts MATCH ? AND m.session_id=? LIMIT ?",
              )
              .all(ftsQuery(query), opts.sessionId, limit)
          : db
              .prepare("SELECT m.* FROM messages_fts f JOIN messages m ON m.id=f.rowid WHERE messages_fts MATCH ? LIMIT ?")
              .all(ftsQuery(query), limit)
      ) as MsgRow[];
      return rows.map(toMessage);
    },
  };
}
