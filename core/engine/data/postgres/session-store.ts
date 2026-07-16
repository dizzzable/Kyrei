import type { SessionStore, SessionRecord, StoredMessage } from "../ports.js";
import type { PgPool } from "./pool.js";

function partsText(parts: StoredMessage["parts"]): string {
  return parts
    .map((p) => {
      if (p.type === "text" || p.type === "reasoning") return p.text;
      if (p.type === "tool") return p.result ?? "";
      if (p.type === "approval") return `[approval:${p.name}:${p.status}]`;
      return "";
    })
    .join("\n")
    .trim();
}

interface SessionRow {
  id: string;
  workspace: string | null;
  title: string | null;
  started_at: Date;
  ended_at: Date | null;
  status: string;
  provider_id: string | null;
  model_id: string | null;
  provider_account_id: string | null;
  meta_json: unknown;
  jsonl_path: string;
  updated_at: Date;
}

interface MsgRow {
  session_id: string;
  seq: number;
  role: string;
  parts_json: unknown;
  text: string | null;
  tool_call_id: string | null;
  token_est: number | null;
  compacted: boolean;
  ccr_hash: string | null;
  created_at: Date;
  client_id: string | null;
  pending: boolean;
  turn_status: string | null;
  approval_model_params_json: unknown;
}

function toRecord(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    workspace: r.workspace ?? undefined,
    title: r.title ?? undefined,
    startedAt: r.started_at.toISOString(),
    endedAt: r.ended_at?.toISOString(),
    status: r.status as SessionRecord["status"],
    providerId: r.provider_id ?? undefined,
    modelId: r.model_id ?? undefined,
    providerAccountId: r.provider_account_id ?? undefined,
    meta: r.meta_json as Record<string, unknown> | undefined,
    jsonlPath: r.jsonl_path,
  };
}

function toMessage(r: MsgRow): StoredMessage {
  return {
    sessionId: r.session_id,
    seq: r.seq,
    role: r.role as StoredMessage["role"],
    parts: r.parts_json as StoredMessage["parts"],
    text: r.text ?? undefined,
    toolCallId: r.tool_call_id ?? undefined,
    tokenEst: r.token_est ?? undefined,
    compacted: r.compacted,
    ccrHash: r.ccr_hash ?? undefined,
    createdAt: r.created_at.toISOString(),
    clientId: r.client_id ?? undefined,
    pending: r.pending ? true : undefined,
    turnStatus: r.turn_status ?? undefined,
    approvalModelParams: r.approval_model_params_json
      ? (r.approval_model_params_json as Record<string, unknown>)
      : undefined,
  };
}

export function createPostgresSessionStore(pool: PgPool): SessionStore {
  return {
    async createSession(rec) {
      await pool.query(
        `INSERT INTO sessions(
           id,workspace,title,started_at,ended_at,status,
           provider_id,model_id,provider_account_id,meta_json,jsonl_path,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT(id) DO UPDATE SET
           workspace=EXCLUDED.workspace,
           title=EXCLUDED.title,
           started_at=EXCLUDED.started_at,
           ended_at=EXCLUDED.ended_at,
           status=EXCLUDED.status,
           provider_id=EXCLUDED.provider_id,
           model_id=EXCLUDED.model_id,
           provider_account_id=EXCLUDED.provider_account_id,
           meta_json=EXCLUDED.meta_json,
           jsonl_path=EXCLUDED.jsonl_path,
           updated_at=EXCLUDED.updated_at`,
        [
          rec.id,
          rec.workspace ?? null,
          rec.title ?? null,
          rec.startedAt,
          rec.endedAt ?? null,
          rec.status,
          rec.providerId ?? null,
          rec.modelId ?? null,
          rec.providerAccountId ?? null,
          rec.meta ? JSON.stringify(rec.meta) : null,
          rec.jsonlPath,
          new Date().toISOString(),
        ],
      );
    },

    async updateSession(id, patch) {
      const res = await pool.query<SessionRow>(
        "SELECT * FROM sessions WHERE id=$1",
        [id],
      );
      if (res.rows.length === 0) return;
      const merged = { ...toRecord(res.rows[0]!), ...patch, id };
      await pool.query(
        `UPDATE sessions SET
           workspace=$2,title=$3,ended_at=$4,status=$5,
           provider_id=$6,model_id=$7,provider_account_id=$8,
           meta_json=$9,updated_at=$10
         WHERE id=$1`,
        [
          id,
          merged.workspace ?? null,
          merged.title ?? null,
          merged.endedAt ?? null,
          merged.status,
          merged.providerId ?? null,
          merged.modelId ?? null,
          merged.providerAccountId ?? null,
          merged.meta ? JSON.stringify(merged.meta) : null,
          new Date().toISOString(),
        ],
      );
    },

    async getSession(id) {
      const res = await pool.query<SessionRow>(
        "SELECT * FROM sessions WHERE id=$1",
        [id],
      );
      return res.rows[0] ? toRecord(res.rows[0]) : null;
    },

    async listSessions(opts) {
      const query = opts?.workspace
        ? "SELECT * FROM sessions WHERE workspace=$1 ORDER BY started_at DESC"
        : "SELECT * FROM sessions ORDER BY started_at DESC";
      const params = opts?.workspace ? [opts.workspace] : [];
      const res = await pool.query<SessionRow>(query, params);
      const list = res.rows.map(toRecord);
      return opts?.limit ? list.slice(0, opts.limit) : list;
    },

    async deleteSession(id) {
      await pool.query("DELETE FROM messages WHERE session_id=$1", [id]);
      await pool.query("DELETE FROM sessions WHERE id=$1", [id]);
    },

    async clearMessages(sessionId) {
      await pool.query("DELETE FROM messages WHERE session_id=$1", [sessionId]);
    },

    async appendMessage(msg) {
      await pool.query(
        `INSERT INTO messages(
           session_id,seq,role,parts_json,text,tool_call_id,token_est,compacted,ccr_hash,created_at,
           client_id,pending,turn_status,approval_model_params_json
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT(session_id,seq) DO UPDATE SET
           role=EXCLUDED.role,
           parts_json=EXCLUDED.parts_json,
           text=EXCLUDED.text,
           tool_call_id=EXCLUDED.tool_call_id,
           token_est=EXCLUDED.token_est,
           compacted=EXCLUDED.compacted,
           ccr_hash=EXCLUDED.ccr_hash,
           created_at=EXCLUDED.created_at,
           client_id=EXCLUDED.client_id,
           pending=EXCLUDED.pending,
           turn_status=EXCLUDED.turn_status,
           approval_model_params_json=EXCLUDED.approval_model_params_json`,
        [
          msg.sessionId,
          msg.seq,
          msg.role,
          JSON.stringify(msg.parts),
          msg.text ?? partsText(msg.parts),
          msg.toolCallId ?? null,
          msg.tokenEst ?? null,
          msg.compacted ?? false,
          msg.ccrHash ?? null,
          msg.createdAt,
          msg.clientId ?? null,
          msg.pending ?? false,
          msg.turnStatus ?? null,
          msg.approvalModelParams ? JSON.stringify(msg.approvalModelParams) : null,
        ],
      );
      return msg.seq;
    },

    async getMessages(sessionId, opts) {
      const query = opts?.fromSeq != null
        ? "SELECT * FROM messages WHERE session_id=$1 AND seq>=$2 ORDER BY seq"
        : "SELECT * FROM messages WHERE session_id=$1 ORDER BY seq";
      const params = opts?.fromSeq != null ? [sessionId, opts.fromSeq] : [sessionId];
      const res = await pool.query<MsgRow>(query, params);
      return res.rows.map(toMessage);
    },

    async markCompacted(sessionId, seqRange, ccrHash) {
      await pool.query(
        "UPDATE messages SET compacted=TRUE, ccr_hash=$1 WHERE session_id=$2 AND seq BETWEEN $3 AND $4",
        [ccrHash, sessionId, seqRange[0], seqRange[1]],
      );
    },

    async searchMessages(query, opts) {
      const limit = opts?.limit ?? 50;
      let sql: string;
      let params: unknown[];
      if (opts?.sessionId) {
        sql = `SELECT * FROM messages WHERE session_id=$1 AND to_tsvector('english', COALESCE(text, '')) @@ plainto_tsquery('english', $2) LIMIT $3`;
        params = [opts.sessionId, query, limit];
      } else {
        sql = `SELECT * FROM messages WHERE to_tsvector('english', COALESCE(text, '')) @@ plainto_tsquery('english', $1) LIMIT $2`;
        params = [query, limit];
      }
      const res = await pool.query<MsgRow>(sql, params);
      return res.rows.map(toMessage);
    },
  };
}
