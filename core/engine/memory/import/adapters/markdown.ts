import { ImportError } from "../errors.js";
import { decodeImportText } from "../decode.js";
import {
  IMPORT_TRANSCRIPT_SCHEMA_VERSION,
  type ImportAdapter,
  type ImportMessageRole,
  type ImportRawInput,
  type ImportedMessage,
  type ImportedTranscript,
} from "../types.js";

const ROLE_LINE = /^(?:#{1,3}\s*)?(?:\*\*)?(user|human|assistant|assistant\s*response|system|claude|chatgpt)(?:\*\*)?\s*[:：]?\s*$/i;
const ROLE_PREFIX = /^(user|human|assistant|system)\s*[:：]\s*(.*)$/is;

function roleFromHeading(raw: string): ImportMessageRole | null {
  const key = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (key.startsWith("user") || key.startsWith("human")) return "user";
  if (key.startsWith("assistant") || key.startsWith("claude") || key.startsWith("chatgpt")) return "assistant";
  if (key.startsWith("system")) return "system";
  return null;
}

function parseMarkdownMessages(text: string): ImportedMessage[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const messages: ImportedMessage[] = [];
  let currentRole: ImportMessageRole | null = null;
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join("\n").trim();
    if (currentRole && body) messages.push({ role: currentRole, text: body });
    buf = [];
  };

  for (const line of lines) {
    const heading = line.match(ROLE_LINE);
    if (heading) {
      flush();
      currentRole = roleFromHeading(heading[1] ?? "") ?? "unknown";
      if (currentRole === "unknown") currentRole = "assistant";
      continue;
    }
    const prefix = line.match(ROLE_PREFIX);
    if (prefix && (prefix[2] !== undefined)) {
      flush();
      currentRole = roleFromHeading(prefix[1] ?? "") ?? "unknown";
      if (currentRole === "unknown") currentRole = "user";
      if (prefix[2].trim()) buf.push(prefix[2]);
      continue;
    }
    if (currentRole) buf.push(line);
  }
  flush();
  return messages;
}

function makeMdAdapter(id: string, source: "claude-code" | "generic", detectBoost: number): ImportAdapter {
  return {
    id,
    source,
    detect(input: ImportRawInput): number {
      const name = input.fileName.toLowerCase();
      const text = decodeImportText(input);
      if (!text.trim()) return 0;
      // Prefer JSON adapters for pure JSON
      if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) return 0.05;
      const sample = text.slice(0, 4000);
      let score = 0.25 + detectBoost;
      if (name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".txt")) score += 0.15;
      if (/#{1,3}\s*(user|assistant|human)/i.test(sample)) score += 0.25;
      if (/^(user|assistant|human)\s*:/im.test(sample)) score += 0.2;
      if (id === "claude-code-md") {
        if (/claude\s*code|\/export/i.test(sample + name)) score += 0.2;
        if (/#{1,3}\s*(user|assistant)/i.test(sample)) score += 0.15;
        score = Math.min(0.88, score);
      }
      if (id === "generic-md") score = Math.min(score, 0.5); // stay below structured/md-specialized
      return Math.min(0.9, score);
    },
    parse(input: ImportRawInput): ImportedTranscript {
      const text = decodeImportText(input);
      let messages = parseMarkdownMessages(text);
      if (!messages.length) {
        const body = text.trim();
        if (!body) throw new ImportError("import_transcript_empty", "markdown has no content");
        messages = [{ role: "user", text: body }];
      }
      return {
        schemaVersion: IMPORT_TRANSCRIPT_SCHEMA_VERSION,
        source,
        title: input.fileName,
        messages,
        meta: { adapter: id },
      };
    },
  };
}

export const claudeCodeMdAdapter = makeMdAdapter("claude-code-md", "claude-code", 0.05);
export const genericMdAdapter = makeMdAdapter("generic-md", "generic", 0);
