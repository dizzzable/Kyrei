import { ImportError } from "../errors.js";
import { decodeImportText, isRecord, tryParseJson } from "../decode.js";
import {
  IMPORT_TRANSCRIPT_SCHEMA_VERSION,
  type ImportAdapter,
  type ImportMessageRole,
  type ImportRawInput,
  type ImportedMessage,
  type ImportedTranscript,
} from "../types.js";

function flattenParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string" && part.text.trim()) chunks.push(part.text);
    else if (typeof part.content === "string" && part.content.trim()) chunks.push(part.content);
  }
  return chunks.join("\n").trim();
}

function mapRole(role: unknown): ImportMessageRole {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") return role;
  return "unknown";
}

export const kyreiExportAdapter: ImportAdapter = {
  id: "kyrei-export",
  source: "kyrei",

  detect(input: ImportRawInput): number {
    const text = decodeImportText(input);
    const json = tryParseJson(text);
    if (!isRecord(json)) return 0;
    if (
      typeof json.exported_at === "string"
      && typeof json.session_id === "string"
      && Array.isArray(json.messages)
    ) {
      return 0.95;
    }
    return 0;
  },

  parse(input: ImportRawInput): ImportedTranscript {
    const text = decodeImportText(input);
    const json = tryParseJson(text);
    if (!isRecord(json) || !Array.isArray(json.messages)) {
      throw new ImportError("import_adapter_parse_failed", "not a Kyrei SessionExport");
    }
    const messages: ImportedMessage[] = [];
    for (const raw of json.messages) {
      if (!isRecord(raw)) continue;
      if (raw.pending === true) continue;
      const role = mapRole(raw.role);
      let body = "";
      if (typeof raw.content === "string") body = raw.content;
      if (!body) body = flattenParts(raw.parts);
      body = body.trim();
      if (!body) continue;
      messages.push({
        role,
        text: body,
        ...(typeof raw.at === "string" ? { at: raw.at } : {}),
      });
    }
    if (!messages.length) {
      throw new ImportError("import_transcript_empty", "kyrei export has no usable messages");
    }
    return {
      schemaVersion: IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      source: "kyrei",
      sourceId: typeof json.session_id === "string" ? json.session_id : undefined,
      title: typeof json.title === "string" ? json.title : undefined,
      createdAt: typeof json.exported_at === "string" ? json.exported_at : undefined,
      messages,
      meta: { adapter: "kyrei-export" },
    };
  },
};
