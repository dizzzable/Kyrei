/**
 * Context compaction (Phase 4). Phase 1: deterministic prune of large tool
 * outputs (reversible via CCR), preserving tool-call/result pairing and the
 * last N messages. Phase 2 (LLM summary) is injectable. Requirements §5.2, §5.3.
 */

import type { ModelMessage } from "ai";
import type { CcrStore } from "./ccr.js";

export interface PruneConfig {
  maxToolOutputChars: number;
  keepLastMessages: number;
  pruneToChars: number;
}

export const DEFAULT_PRUNE: PruneConfig = {
  maxToolOutputChars: 4000,
  keepLastMessages: 6,
  pruneToChars: 500,
};

function truncateWithMarker(text: string, toChars: number, hash: string): string {
  const head = text.slice(0, Math.floor(toChars * 0.6));
  const tail = text.slice(text.length - Math.floor(toChars * 0.4));
  return `[tool output truncated: ${text.length} chars. Full output retrievable via retrieve("${hash}")]\n${head}\n…\n${tail}`;
}

function outputToString(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
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
): Promise<{ messages: ModelMessage[]; prunedCount: number }> {
  const cut = Math.max(0, messages.length - cfg.keepLastMessages);
  let prunedCount = 0;
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
        const hash = await ccr.put(text);
        prunedCount++;
        changed = true;
        return { ...p, output: truncateWithMarker(text, cfg.pruneToChars, hash) };
      }),
    );
    out.push(changed ? ({ ...m, content: newParts } as unknown as ModelMessage) : m);
  }
  return { messages: out, prunedCount };
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
