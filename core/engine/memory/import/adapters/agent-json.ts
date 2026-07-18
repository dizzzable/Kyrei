import { ImportError } from "../errors.js";
import { decodeImportText, isRecord, tryParseJson } from "../decode.js";
import {
  IMPORT_TRANSCRIPT_SCHEMA_VERSION,
  type ImportAdapter,
  type ImportRawInput,
  type ImportedMessage,
  type ImportedTranscript,
} from "../types.js";
import { importedConversationMessage } from "./message-text.js";

const CHILD_KEYS = ["messages", "conversation", "conversations", "chat", "chats", "history", "items"];

function collect(value: unknown, out: ImportedMessage[], seen: Set<unknown>): void {
  if (!value || seen.has(value)) return;
  if (typeof value === "object") seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out, seen);
    return;
  }
  if (!isRecord(value)) return;
  const message = importedConversationMessage(value);
  if (message) out.push(message);
  for (const key of CHILD_KEYS) {
    if (value[key] !== undefined) collect(value[key], out, seen);
  }
}

function rootMetadata(root: unknown): Record<string, unknown> {
  if (!isRecord(root)) return {};
  if (isRecord(root.conversation)) return { ...root, ...root.conversation };
  return root;
}

export const agentJsonAdapter: ImportAdapter = {
  id: "agent-json",
  source: "generic",

  detect(input): number {
    const text = decodeImportText(input);
    const root = tryParseJson(text);
    if (!isRecord(root) && !Array.isArray(root)) return 0;
    if (isRecord(root) && (Object.hasOwn(root, "session") || root.type === "session_meta")) return 0.1;
    if (isRecord(root) && typeof root.id === "string" && root.id.startsWith("ses_")) return 0.15;
    const messages: ImportedMessage[] = [];
    collect(root, messages, new Set());
    if (messages.length < 2) return 0.2;
    const hasBoth = messages.some((message) => message.role === "user")
      && messages.some((message) => message.role === "assistant");
    return hasBoth ? 0.82 : 0.65;
  },

  parse(input): ImportedTranscript {
    const root = tryParseJson(decodeImportText(input));
    if (root === undefined) throw new ImportError("import_adapter_parse_failed", "agent export is not valid JSON");
    const messages: ImportedMessage[] = [];
    collect(root, messages, new Set());
    if (!messages.length) throw new ImportError("import_transcript_empty", "agent JSON has no usable messages");
    const meta = rootMetadata(root);
    return {
      schemaVersion: IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      source: "generic",
      sourceId: typeof meta.id === "string"
        ? meta.id
        : typeof meta.session_id === "string"
          ? meta.session_id
          : undefined,
      title: typeof meta.title === "string" ? meta.title : input.fileName,
      workspaceHint: typeof meta.cwd === "string" ? meta.cwd : undefined,
      messages,
      meta: { adapter: "agent-json" },
    };
  },
};
