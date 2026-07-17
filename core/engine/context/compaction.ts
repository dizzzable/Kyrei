/**
 * Context compaction (two-stage).
 * Stage A: deterministic prune of large tool outputs (reversible via CCR).
 * Stage B: structured middle-turn summary for model projection only
 * (chat JSON SoT is never rewritten). Requirements §5.2, §5.3, §5.4.
 */

import type { ModelMessage } from "ai";
import type { CcrStore } from "./ccr.js";
import { compressToolOutput } from "./tool-compress.js";

export interface PruneConfig {
  maxToolOutputChars: number;
  keepLastMessages: number;
  pruneToChars: number;
  /** When true (default), use content-aware compress before head/tail stub. */
  smartCompress?: boolean;
  /** Wave D1: goal/focus string for skim-aware compress. */
  focus?: string;
  /** Wave D1: enable goal skim (default true). */
  goalSkim?: boolean;
}

export const DEFAULT_PRUNE: PruneConfig = {
  maxToolOutputChars: 4000,
  keepLastMessages: 6,
  pruneToChars: 500,
  smartCompress: true,
  goalSkim: true,
};

export interface SummaryProtectConfig {
  protectFirstN: number;
  protectLastN: number;
  summaryMinMessages: number;
}

export const DEFAULT_SUMMARY_PROTECT: SummaryProtectConfig = {
  protectFirstN: 2,
  protectLastN: 6,
  summaryMinMessages: 12,
};

export const SUMMARY_END_MARKER = "--- END OF CONTEXT SUMMARY ---";
export const KYREI_COMPRESSED_SUMMARY = "_kyreiCompressedSummary";

function truncateWithMarker(text: string, toChars: number, hash: string): string {
  const head = text.slice(0, Math.floor(toChars * 0.6));
  const tail = text.slice(text.length - Math.floor(toChars * 0.4));
  return `[tool output truncated: ${text.length} chars. Full output retrievable via retrieve("${hash}")]\n${head}\n…\n${tail}`;
}

async function pruneOneOutput(
  text: string,
  cfg: PruneConfig,
  ccr: CcrStore,
  toolName?: string,
): Promise<{ text: string; rawChars: number; shownChars: number; skimmed: boolean }> {
  const rawChars = text.length;
  if (cfg.smartCompress !== false) {
    const result = await compressToolOutput(text, {
      maxChars: Math.max(cfg.pruneToChars, Math.min(cfg.maxToolOutputChars, 2_500)),
      ccr,
      headRatio: 0.55,
      ...(toolName ? { toolName } : {}),
      ...(cfg.focus ? { focus: cfg.focus } : {}),
      goalSkim: cfg.goalSkim !== false,
    });
    if (result.compressed && result.hash) {
      return {
        text: result.text,
        rawChars,
        shownChars: result.text.length,
        skimmed: Boolean(cfg.focus) && result.kind === "code",
      };
    }
    if (result.compressed) {
      // CCR put failed — fall through to classic marker with fresh put
    } else {
      return {
        text: result.text,
        rawChars,
        shownChars: result.text.length,
        skimmed: false,
      };
    }
  }
  const hash = await ccr.put(text);
  const out = truncateWithMarker(text, cfg.pruneToChars, hash);
  return { text: out, rawChars, shownChars: out.length, skimmed: false };
}

function outputToString(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Prune large tool-result outputs in messages older than the last N. Only
 * touches role:"tool" messages, never the assistant tool-call → pairing intact.
 * Originals are stored in CCR so they remain recallable (Property 6).
 */
export async function pruneToolOutputs(
  messages: ModelMessage[],
  ccr: CcrStore,
  cfg: PruneConfig = DEFAULT_PRUNE,
): Promise<{
  messages: ModelMessage[];
  prunedCount: number;
  bytesRaw: number;
  bytesShown: number;
  goalSkims: number;
}> {
  const cut = Math.max(0, messages.length - cfg.keepLastMessages);
  let prunedCount = 0;
  let bytesRaw = 0;
  let bytesShown = 0;
  let goalSkims = 0;
  const out: ModelMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (i >= cut || m.role !== "tool" || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const parts = m.content as unknown as Array<Record<string, unknown>>;
    let changed = false;
    const newParts = await Promise.all(
      parts.map(async (p) => {
        if (p["type"] !== "tool-result") return p;
        const text = outputToString(p["output"]);
        if (text.length <= cfg.maxToolOutputChars) return p;
        const toolName = typeof p["toolName"] === "string" ? p["toolName"] : undefined;
        prunedCount++;
        changed = true;
        const pruned = await pruneOneOutput(text, cfg, ccr, toolName);
        bytesRaw += pruned.rawChars;
        bytesShown += pruned.shownChars;
        if (pruned.skimmed) goalSkims += 1;
        return { ...p, output: pruned.text };
      }),
    );
    out.push(changed ? ({ ...m, content: newParts } as unknown as ModelMessage) : m);
  }
  return { messages: out, prunedCount, bytesRaw, bytesShown, goalSkims };
}

/** Early incremental checkpoint marks (fractions of the soft budget). */
export const CHECKPOINT_MARKS = [0.2, 0.45, 0.7] as const;

/** Returns the mark that just crossed (once each), or null. */
export function firedCheckpointMark(effective: number, checkpointBudget: number, fired: Set<number>): number | null {
  if (checkpointBudget <= 0) return null;
  const ratio = effective / checkpointBudget;
  for (const mark of CHECKPOINT_MARKS) {
    if (ratio >= mark && !fired.has(mark)) {
      fired.add(mark);
      return mark;
    }
  }
  return null;
}

function messageText(m: ModelMessage): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  const chunks: string[] = [];
  for (const part of m.content as unknown as Array<Record<string, unknown>>) {
    if (!part || typeof part !== "object") continue;
    if (typeof part["text"] === "string") chunks.push(part["text"]);
    if (part["type"] === "tool-call" && typeof part["toolName"] === "string") {
      chunks.push(`[tool_call ${part["toolName"]}]`);
    }
    if (part["type"] === "tool-result") {
      const out = outputToString(part["output"]);
      chunks.push(clip(out, 400));
    }
  }
  return chunks.join("\n");
}

function isSystemRole(m: ModelMessage): boolean {
  return m.role === "system";
}

function hasToolCalls(m: ModelMessage | undefined): boolean {
  if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return false;
  return (m.content as unknown as Array<Record<string, unknown>>).some(
    (p) => p && (p["type"] === "tool-call" || p["type"] === "tool-use"),
  );
}

/**
 * Align index so we never split an assistant tool-call from its tool results.
 * - start: skip leading tool messages into the window (pair belongs with prior assistant).
 * - end: if the cut would land on tool results, pull them fully into middle OR
 *   expand tail to include the owning assistant tool-call.
 */
export function alignProtectBoundary(messages: ModelMessage[], index: number, direction: "start" | "end"): number {
  let i = Math.max(0, Math.min(messages.length, index));
  if (direction === "start") {
    while (i < messages.length && messages[i]?.role === "tool") i += 1;
    return i;
  }
  // Expand left past any tool results so we don't start tail mid-pair.
  while (i > 0 && messages[i - 1]?.role === "tool") i -= 1;
  // If next message is tool and previous is assistant with tool-calls, include assistant in tail
  // by moving cut left to that assistant (i already at first tool-call message if we walked tools).
  // After walking tools back, if messages[i] is tool (cut still on tool), include owning assistant.
  if (i < messages.length && messages[i]?.role === "tool") {
    let j = i;
    while (j > 0 && messages[j - 1]?.role === "tool") j -= 1;
    if (j > 0 && hasToolCalls(messages[j - 1])) i = j - 1;
    else i = Math.min(messages.length, i + 1); // orphan tools → push into middle
  }
  // If cut is right after an assistant tool-call (messages[i] would be tool), include tools in tail
  // by leaving i before assistant... Actually if messages[i-1] has tool-calls and messages[i] is tool,
  // tools belong with assistant: move i left to assistant.
  if (i > 0 && i < messages.length && messages[i]?.role === "tool" && hasToolCalls(messages[i - 1])) {
    i -= 1;
  }
  return Math.max(0, Math.min(messages.length, i));
}

export interface ProtectWindows {
  head: ModelMessage[];
  middle: ModelMessage[];
  tail: ModelMessage[];
  /** False when history too short or middle empty. */
  canSummarize: boolean;
}

/**
 * Split messages into protected head / compressible middle / protected tail.
 * System messages at the start always stay in head.
 */
export function selectProtectWindows(
  messages: ModelMessage[],
  cfg: SummaryProtectConfig = DEFAULT_SUMMARY_PROTECT,
): ProtectWindows {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length < cfg.summaryMinMessages) {
    return { head: list, middle: [], tail: [], canSummarize: false };
  }

  let sysEnd = 0;
  while (sysEnd < list.length && isSystemRole(list[sysEnd]!)) sysEnd += 1;

  const nonSystem = list.length - sysEnd;
  const headExtra = Math.min(cfg.protectFirstN, Math.max(0, nonSystem - cfg.protectLastN));
  let headEnd = sysEnd + headExtra;
  headEnd = alignProtectBoundary(list, headEnd, "start");

  let tailStart = Math.max(headEnd, list.length - cfg.protectLastN);
  tailStart = alignProtectBoundary(list, tailStart, "end");
  if (tailStart < headEnd) tailStart = headEnd;

  const head = list.slice(0, headEnd);
  const middle = list.slice(headEnd, tailStart);
  const tail = list.slice(tailStart);

  if (middle.length < 2) {
    return { head: list, middle: [], tail: [], canSummarize: false };
  }

  // Require meaningful savings (≥10% of messages removed from live path).
  const after = head.length + 1 + tail.length;
  if (after >= list.length * 0.9) {
    return { head: list, middle: [], tail: [], canSummarize: false };
  }

  return { head, middle, tail, canSummarize: true };
}

/** Pure heuristic structured summary — offline, no network. */
export function buildHeuristicSummary(
  middle: ModelMessage[],
  opts: { previousSummary?: string; middleCcrHash?: string } = {},
): string {
  const tasks: string[] = [];
  const done: string[] = [];
  const nexts: string[] = [];
  const files: string[] = [];
  const notes: string[] = [];
  const toolCounts = new Map<string, number>();

  for (const m of middle) {
    const text = messageText(m);
    if (!text.trim()) continue;
    if (m.role === "user") {
      tasks.push(clip(text, 240));
    } else if (m.role === "assistant") {
      for (const line of text.split(/\n+/)) {
        const bare = line.replace(/^[-*•]\s*/, "").trim();
        if (/^(done|fixed|implemented|merged|completed|сделано|готово)\b/i.test(bare)) {
          done.push(clip(bare, 200));
        } else if (/^(todo|next|should|need to|далее|нужно)\b/i.test(bare)) {
          nexts.push(clip(bare, 200));
        } else if (/^(decided|decision|we will|выбрали|решени)/i.test(bare)) {
          notes.push(clip(bare, 200));
        }
      }
      if (Array.isArray(m.content)) {
        for (const part of m.content as unknown as Array<Record<string, unknown>>) {
          if (part?.["type"] === "tool-call" && typeof part["toolName"] === "string") {
            const name = part["toolName"];
            toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
            const input = part["input"];
            if (input && typeof input === "object") {
              const path = (input as Record<string, unknown>)["path"]
                ?? (input as Record<string, unknown>)["file"]
                ?? (input as Record<string, unknown>)["target"];
              if (typeof path === "string" && path.length < 260) files.push(path);
            }
          }
        }
      }
    }
  }

  const uniq = (arr: string[], n: number) => [...new Set(arr)].slice(0, n);
  const tools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, n]) => `${name}×${n}`);

  const lines = [
    "## Context summary (reference only)",
    "_This is historical context for the model. Prefer the latest user message and live tool results. Do not re-execute completed work unless the user asks._",
    "",
  ];
  if (opts.previousSummary?.trim()) {
    lines.push("### Previous rolling summary", clip(opts.previousSummary, 1_200), "");
  }
  const taskSnap = uniq(tasks, 4);
  if (taskSnap.length) {
    lines.push("### Task snapshot", ...taskSnap.map((t) => `- ${t}`), "");
  }
  const d = uniq(done, 8);
  if (d.length) lines.push("### Done / actions", ...d.map((t) => `- ${t}`), "");
  if (tools.length) lines.push("### Tools used", ...tools.map((t) => `- ${t}`), "");
  const n = uniq(nexts, 8);
  if (n.length) lines.push("### Open threads", ...n.map((t) => `- ${t}`), "");
  const f = uniq(files, 12);
  if (f.length) lines.push("### Key files", ...f.map((t) => `- ${t}`), "");
  const nt = uniq(notes, 6);
  if (nt.length) lines.push("### Notes", ...nt.map((t) => `- ${t}`), "");
  if (opts.middleCcrHash) {
    lines.push(
      "### Archived middle transcript",
      `Full middle turns retrievable via retrieve("${opts.middleCcrHash}").`,
      "",
    );
  }
  lines.push(SUMMARY_END_MARKER);
  return lines.join("\n").trim();
}

export function buildSummaryMessage(summaryText: string): ModelMessage {
  const body = summaryText.includes(SUMMARY_END_MARKER)
    ? summaryText
    : `${summaryText}\n\n${SUMMARY_END_MARKER}`;
  // user role avoids assistant→assistant alternation issues on strict backends
  return {
    role: "user",
    content: body,
    [KYREI_COMPRESSED_SUMMARY]: true,
  } as ModelMessage & { [KYREI_COMPRESSED_SUMMARY]?: boolean };
}

export function reassembleWithSummary(
  head: ModelMessage[],
  summaryText: string,
  tail: ModelMessage[],
): ModelMessage[] {
  return [...head, buildSummaryMessage(summaryText), ...tail];
}

export interface StageBResult {
  messages: ModelMessage[];
  summarized: boolean;
  via: "heuristic" | "llm" | "none";
  summaryText?: string;
  middleCcrHash?: string;
  middleCount: number;
}

/**
 * Stage B: if windows allow, dump middle to CCR, build summary, reassemble.
 * Pure heuristic unless `llmSummarize` returns non-empty text.
 */
export async function summarizeMiddleTurns(
  messages: ModelMessage[],
  opts: {
    ccr?: CcrStore;
    protect?: SummaryProtectConfig;
    previousSummary?: string;
    llmSummarize?: (middleText: string, previous?: string) => Promise<string | null>;
  } = {},
): Promise<StageBResult> {
  const protect = { ...DEFAULT_SUMMARY_PROTECT, ...(opts.protect ?? {}) };
  const windows = selectProtectWindows(messages, protect);
  if (!windows.canSummarize) {
    return { messages, summarized: false, via: "none", middleCount: 0 };
  }

  let middleCcrHash: string | undefined;
  const middleBlob = windows.middle
    .map((m, i) => `${m.role?.toUpperCase?.() ?? "MSG"}[${i}]: ${messageText(m)}`)
    .join("\n\n")
    .slice(0, 200_000);

  if (opts.ccr && middleBlob.length > 200) {
    try {
      middleCcrHash = await opts.ccr.put(middleBlob);
    } catch {
      middleCcrHash = undefined;
    }
  }

  let via: "heuristic" | "llm" = "heuristic";
  let summaryText = buildHeuristicSummary(windows.middle, {
    previousSummary: opts.previousSummary,
    middleCcrHash,
  });

  if (opts.llmSummarize) {
    try {
      const llm = await opts.llmSummarize(middleBlob.slice(0, 24_000), opts.previousSummary);
      if (typeof llm === "string" && llm.trim().length >= 40) {
        let body = llm.trim();
        if (!body.includes("reference only") && !body.includes("REFERENCE")) {
          body = [
            "## Context summary (reference only)",
            "_Historical context. Prefer the latest user message._",
            "",
            body,
          ].join("\n");
        }
        if (middleCcrHash && !body.includes(middleCcrHash)) {
          body += `\n\nFull middle turns: retrieve("${middleCcrHash}").`;
        }
        if (!body.includes(SUMMARY_END_MARKER)) body += `\n\n${SUMMARY_END_MARKER}`;
        summaryText = body;
        via = "llm";
      }
    } catch {
      /* heuristic already set */
    }
  }

  if (!summaryText.trim() || summaryText.trim().length < 40) {
    return { messages, summarized: false, via: "none", middleCount: windows.middle.length };
  }

  return {
    messages: reassembleWithSummary(windows.head, summaryText, windows.tail),
    summarized: true,
    via,
    summaryText,
    middleCcrHash,
    middleCount: windows.middle.length,
  };
}
