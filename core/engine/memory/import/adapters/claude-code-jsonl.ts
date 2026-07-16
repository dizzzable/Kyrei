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

function mapRole(role: unknown): ImportMessageRole {
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "model") return "assistant";
  if (role === "system") return "system";
  if (role === "tool") return "tool";
  return "unknown";
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block.trim()) chunks.push(block.trim());
      continue;
    }
    if (!isRecord(block)) continue;
    if (typeof block.text === "string" && block.text.trim()) chunks.push(block.text.trim());
    else if (typeof block.content === "string" && block.content.trim()) chunks.push(block.content.trim());
  }
  return chunks.join("\n").trim();
}

function messageFromLine(obj: Record<string, unknown>): ImportedMessage | null {
  // Nested message envelope
  const nested = isRecord(obj.message) ? obj.message : obj;
  const role = mapRole(nested.role ?? obj.role ?? obj.type);
  let text = contentToText(nested.content ?? nested.text ?? obj.content ?? obj.text);
  if (!text && typeof obj.prompt === "string") text = obj.prompt.trim();
  if (!text) return null;
  if (role === "unknown" && (obj.type === "user" || obj.type === "assistant")) {
    return { role: obj.type === "user" ? "user" : "assistant", text };
  }
  if (role === "unknown") return null;
  return {
    role,
    text,
    ...(typeof nested.timestamp === "string"
      ? { at: nested.timestamp }
      : typeof obj.timestamp === "string"
        ? { at: obj.timestamp }
        : {}),
  };
}

export const claudeCodeJsonlAdapter: ImportAdapter = {
  id: "claude-code-jsonl",
  source: "claude-code",

  detect(input: ImportRawInput): number {
    const name = input.fileName.toLowerCase();
    if (!name.endsWith(".jsonl") && !name.endsWith(".jsonl.txt")) {
      // still allow if content is line-json
      const text = decodeImportText(input).trim();
      const first = text.split(/\r?\n/).find((l) => l.trim());
      if (!first) return 0;
      const obj = tryParseJson(first);
      if (!isRecord(obj)) return 0;
    }
    const text = decodeImportText(input);
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
    let hits = 0;
    for (const line of lines) {
      const obj = tryParseJson(line);
      if (!isRecord(obj)) continue;
      if (obj.role || obj.message || obj.type === "user" || obj.type === "assistant") hits += 1;
    }
    if (hits === 0) return 0;
    let score = 0.45 + hits * 0.1;
    if (name.endsWith(".jsonl")) score += 0.2;
    if (name.includes("claude")) score += 0.1;
    return Math.min(0.93, score);
  },

  parse(input: ImportRawInput): ImportedTranscript {
    const text = decodeImportText(input);
    const messages: ImportedMessage[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const obj = tryParseJson(line);
      if (!isRecord(obj)) continue;
      const msg = messageFromLine(obj);
      if (msg) messages.push(msg);
    }
    if (!messages.length) {
      throw new ImportError("import_transcript_empty", "claude-code jsonl has no usable messages");
    }
    return {
      schemaVersion: IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      source: "claude-code",
      messages,
      meta: { adapter: "claude-code-jsonl", fileName: input.fileName },
    };
  },
};
