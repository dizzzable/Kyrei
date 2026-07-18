import { ImportError } from "../errors.js";
import { decodeImportText, isRecord, tryParseJson } from "../decode.js";
import {
  IMPORT_TRANSCRIPT_SCHEMA_VERSION,
  type ImportAdapter,
  type ImportRawInput,
  type ImportedMessage,
  type ImportedTranscript,
} from "../types.js";
import { importedConversationMessage, isoTime } from "./message-text.js";

function jsonRecords(text: string): Record<string, unknown>[] {
  const whole = tryParseJson(text);
  if (isRecord(whole)) return [whole];
  if (Array.isArray(whole)) return whole.filter(isRecord);
  return text.split(/\r?\n/).map((line) => tryParseJson(line)).filter(isRecord);
}

function requestBody(record: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(record.request) || !isRecord(record.request.body)) return null;
  return record.request.body;
}

function sessionsFrom(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const row of records) {
    const body = requestBody(row);
    if (body && Array.isArray(body.messages)) {
      out.push({
        ...body,
        id: row.session_id,
        started_at: row.timestamp,
        title: `Hermes request ${row.reason ?? "dump"}`,
      });
      continue;
    }
    if (Array.isArray(row.messages)) out.push(row);
    if (Array.isArray(row.sessions)) out.push(...row.sessions.filter(isRecord));
  }
  return out;
}

function scoreHermes(input: ImportRawInput): number {
  const text = decodeImportText(input);
  const records = jsonRecords(text);
  if (!records.length) return 0;
  const first = records[0]!;
  if (requestBody(first) && "reason" in first && "session_id" in first) return 0.99;
  if (Object.hasOwn(first, "session") && typeof first.session_id === "string" && Array.isArray(first.messages)) return 0.98;
  if (input.fileName.toLowerCase().includes("hermes") && sessionsFrom(records).length) return 0.94;
  if (records.some((row) => Array.isArray(row.messages) && ("started_at" in row || "end_reason" in row) && "source" in row)) return 0.9;
  return 0;
}

export const hermesJsonAdapter: ImportAdapter = {
  id: "hermes-json",
  source: "hermes",

  detect: scoreHermes,

  parse(input: ImportRawInput): ImportedTranscript {
    const sessions = sessionsFrom(jsonRecords(decodeImportText(input)));
    if (!sessions.length) throw new ImportError("import_adapter_parse_failed", "not a Hermes session export");
    const messages: ImportedMessage[] = [];
    for (const session of sessions) {
      for (const row of Array.isArray(session.messages) ? session.messages : []) {
        const message = importedConversationMessage(row);
        if (message) messages.push(message);
      }
    }
    if (!messages.length) throw new ImportError("import_transcript_empty", "Hermes export has no user/assistant history");
    const first = sessions[0]!;
    return {
      schemaVersion: IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      source: "hermes",
      sourceId: typeof first.id === "string"
        ? first.id
        : typeof first.session_id === "string"
          ? first.session_id
          : undefined,
      title: typeof first.title === "string" ? first.title : input.fileName,
      createdAt: isoTime(first.started_at ?? first.created_at),
      workspaceHint: typeof first.cwd === "string" ? first.cwd : undefined,
      messages,
      meta: { adapter: "hermes-json", sessions: sessions.length },
    };
  },
};
