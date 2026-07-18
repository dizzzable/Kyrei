import { ImportError } from "../errors.js";
import { decodeImportText, isRecord, tryParseJson } from "../decode.js";
import {
  IMPORT_TRANSCRIPT_SCHEMA_VERSION,
  type ImportAdapter,
  type ImportRawInput,
  type ImportedMessage,
  type ImportedTranscript,
} from "../types.js";
import { importedConversationMessage, importedText } from "./message-text.js";

function rows(input: ImportRawInput): Record<string, unknown>[] {
  return decodeImportText(input)
    .split(/\r?\n/)
    .map((line) => tryParseJson(line))
    .filter(isRecord);
}

export const codexCliJsonlAdapter: ImportAdapter = {
  id: "codex-cli-jsonl",
  source: "codex",

  detect(input): number {
    const sample = rows(input).slice(0, 20);
    if (!sample.length) return 0;
    const meta = sample.some((row) => row.type === "session_meta" && isRecord(row.payload));
    const response = sample.some((row) => row.type === "response_item" && isRecord(row.payload));
    if (meta && response) return 0.98;
    if (input.fileName.toLowerCase().includes("rollout") && response) return 0.9;
    return 0;
  },

  parse(input): ImportedTranscript {
    const inputRows = rows(input);
    const metaRow = inputRows.find((row) => row.type === "session_meta" && isRecord(row.payload));
    const meta = isRecord(metaRow?.payload) ? metaRow.payload : {};
    const messages: ImportedMessage[] = [];
    for (const row of inputRows) {
      if (row.type !== "response_item" || !isRecord(row.payload)) continue;
      const payload = row.payload;
      if (payload.type === "message") {
        const message = importedConversationMessage({ ...payload, timestamp: row.timestamp });
        if (message) messages.push(message);
        continue;
      }
      if (payload.type === "function_call") {
        const name = typeof payload.name === "string" ? payload.name : "tool";
        const args = importedText(payload.arguments).slice(0, 2_000);
        messages.push({ role: "tool", text: `[tool:${name}]${args ? `\n${args}` : ""}` });
      }
    }
    if (!messages.some((message) => message.role === "user" || message.role === "assistant")) {
      throw new ImportError("import_transcript_empty", "Codex rollout has no user/assistant history");
    }
    return {
      schemaVersion: IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      source: "codex",
      sourceId: typeof meta.session_id === "string"
        ? meta.session_id
        : typeof meta.id === "string"
          ? meta.id
          : undefined,
      title: input.fileName,
      createdAt: typeof meta.timestamp === "string" ? meta.timestamp : undefined,
      workspaceHint: typeof meta.cwd === "string" ? meta.cwd : undefined,
      messages,
      meta: { adapter: "codex-cli-jsonl", provider: meta.model_provider },
    };
  },
};
