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
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") return role;
  return "unknown";
}

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const chunks: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text" && typeof part.text === "string" && part.text.trim()) {
      chunks.push(part.text.trim());
      continue;
    }
    if (type === "tool") {
      const tool = typeof part.tool === "string" ? part.tool : "tool";
      chunks.push(`[tool:${tool}]`);
    }
  }
  return chunks.join("\n").trim();
}

function collectMessages(root: unknown): ImportedMessage[] {
  const out: ImportedMessage[] = [];

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;

    // OpenCode-style message: { role, data? } or embedded info
    const roleRaw = node.role ?? (isRecord(node.data) ? node.data.role : undefined);
    if (typeof roleRaw === "string") {
      const role = mapRole(roleRaw);
      let text = "";
      if (typeof node.text === "string") text = node.text;
      if (!text && typeof node.content === "string") text = node.content;
      if (!text && Array.isArray(node.parts)) text = textFromParts(node.parts);
      // parts may live beside data on export wrappers
      if (!text && isRecord(node.info) && Array.isArray((node as { parts?: unknown }).parts)) {
        text = textFromParts((node as { parts?: unknown }).parts);
      }
      text = text.trim();
      if (text && (role === "user" || role === "assistant" || role === "system" || role === "tool")) {
        out.push({
          role,
          text,
          ...(typeof node.id === "string" ? {} : {}),
        });
      }
    }

    // Nested arrays commonly named messages / items
    for (const key of ["messages", "items", "parts"]) {
      if (Array.isArray(node[key]) && key !== "parts") visit(node[key]);
    }
  };

  visit(root);
  return out;
}

export const opencodeJsonAdapter: ImportAdapter = {
  id: "opencode-json",
  source: "opencode",

  detect(input: ImportRawInput): number {
    const name = input.fileName.toLowerCase();
    const text = decodeImportText(input);
    const json = tryParseJson(text);
    if (!isRecord(json) && !Array.isArray(json)) return 0;
    let score = 0;
    if (name.includes("opencode") || name.includes("session")) score += 0.15;
    const raw = text.slice(0, 2000);
    if (raw.includes("sessionID") || raw.includes("\"parts\"") || raw.includes("ses_")) score += 0.35;
    if (raw.includes("\"role\":\"user\"") || raw.includes("\"role\": \"user\"")) score += 0.25;
    if (raw.includes("providerID") || raw.includes("modelID")) score += 0.15;
    // Prefer kyrei when both match
    if (isRecord(json) && typeof json.exported_at === "string" && typeof json.session_id === "string") {
      return 0.2;
    }
    return Math.min(0.92, score);
  },

  parse(input: ImportRawInput): ImportedTranscript {
    const text = decodeImportText(input);
    const json = tryParseJson(text);
    if (json === undefined) {
      throw new ImportError("import_adapter_parse_failed", "opencode export is not valid JSON");
    }
    const messages = collectMessages(json);
    if (!messages.length) {
      throw new ImportError("import_transcript_empty", "opencode export has no user/assistant text");
    }
    let sourceId: string | undefined;
    let title: string | undefined;
    if (isRecord(json)) {
      if (typeof json.id === "string") sourceId = json.id;
      if (typeof json.sessionID === "string") sourceId = json.sessionID;
      if (isRecord(json.info) && typeof json.info.id === "string") sourceId = json.info.id;
      if (typeof json.title === "string") title = json.title;
      if (isRecord(json.info) && typeof json.info.title === "string") title = json.info.title;
    }
    return {
      schemaVersion: IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      source: "opencode",
      sourceId,
      title,
      messages,
      meta: { adapter: "opencode-json" },
    };
  },
};
