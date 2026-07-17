/**
 * Renderer mirror of engine coding modes (keep IDs in sync with core/engine/coding-mode.ts).
 */

export type CodingMode = "auto" | "plan" | "build" | "polish" | "deepreep";

export const CODING_MODE_IDS = [
  "auto",
  "plan",
  "build",
  "polish",
  "deepreep",
] as const satisfies readonly CodingMode[];

const MODE_SET = new Set<string>(CODING_MODE_IDS);

export function isCodingMode(value: unknown): value is CodingMode {
  return typeof value === "string" && MODE_SET.has(value);
}

export function normalizeCodingMode(value: unknown, fallback: CodingMode = "auto"): CodingMode {
  if (value === "balanced") return "auto";
  return isCodingMode(value) ? value : fallback;
}

/** Parse `/mode plan` args or bare mode names. */
export function parseCodingModeArg(arg: string | undefined | null): CodingMode | null {
  const raw = String(arg ?? "").trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!raw) return null;
  if (raw === "balanced") return "auto";
  if (raw === "deep" || raw === "research" || raw === "deep-research") return "deepreep";
  return isCodingMode(raw) ? raw : null;
}

export function codingModeAssignmentRole(
  mode: CodingMode,
): "build" | "polish" | "deepreep" | "plan" | null {
  if (mode === "build") return "build";
  if (mode === "polish") return "polish";
  if (mode === "deepreep") return "deepreep";
  if (mode === "plan") return "plan";
  return null;
}

/**
 * Detect a mode switch declared by the model (auto phase selection).
 * Last match wins. Mirrors core/engine/coding-mode.ts.
 */
export function detectCodingModeSwitch(text: string): CodingMode | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const patterns = [
    /Effective\s+phase\s*:\s*(plan|build|polish|deepreep|auto)\b/gi,
    /MODE_SWITCH\s*:\s*(plan|build|polish|deepreep|auto)\b/gi,
    /\[\[\s*mode\s*:\s*(plan|build|polish|deepreep|auto)\s*\]\]/gi,
    /\/mode\s+(plan|build|polish|deepreep|auto)\b/gi,
  ];
  let last: CodingMode | null = null;
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const raw = match[1]?.toLowerCase();
      if (isCodingMode(raw)) last = raw;
    }
  }
  return last;
}

/** Map pipeline stage id/name → mode (department stages only). */
export function codingModeForPipelineStage(stage: {
  id?: string;
  name?: string;
  kind?: string;
}): CodingMode {
  if (stage.kind && stage.kind !== "department") return "auto";
  const key = `${stage.id ?? ""} ${stage.name ?? ""}`.toLowerCase();
  if (/(research|deepreep|investigat|discover|scout)/.test(key)) return "deepreep";
  if (/(plan|design|architect|roadmap)/.test(key)) return "plan";
  if (/(verif|review|accept|qa|test|polish|audit|harden)/.test(key)) return "polish";
  if (/(implement|execut|build|code|develop|apply)/.test(key)) return "build";
  return "auto";
}

/** Pull plain text from message content (AI SDK parts or string). */
export function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if ((record.type === "text" || record.type === "reasoning") && typeof record.text === "string") {
      chunks.push(record.text);
    }
  }
  return chunks.join("\n");
}

/**
 * Effective mode for a turn: fixed UI mode wins; auto scans assistant text.
 * Mirrors core/engine/coding-mode.ts.
 */
export function effectiveCodingModeFromMessages(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
  configured: CodingMode | undefined | null,
): CodingMode {
  const mode = normalizeCodingMode(configured);
  if (mode !== "auto") return mode;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const detected = detectCodingModeSwitch(textFromMessageContent(msg.content));
    if (detected && detected !== "auto") return detected;
  }
  return "auto";
}
