/**
 * Token estimation (Phase 4). Per-provider tokenizer + heuristic fallback,
 * dual-trigger overflow (max(localEstimate, providerUsage)). Requirements §5.1, §7.8.
 */

import type { ModelMessage } from "ai";
import type { Usage } from "../types.js";

export type TokenizerKind = "o200k" | "cl100k" | "heuristic";

export function pickTokenizer(model: string): TokenizerKind {
  const m = model.toLowerCase();
  if (/(gpt-4o|gpt-4\.1|o1|o3|o4|omni)/.test(m)) return "o200k";
  if (/(gpt-4|gpt-3\.5|turbo|cl100k|text-embedding)/.test(m)) return "cl100k";
  return "heuristic";
}

const SAFETY_MARGIN = 1.15;
const PER_MESSAGE_OVERHEAD = 4;

export function heuristicCount(text: string): number {
  const chars = text.length;
  const words = (text.match(/\S+/g) ?? []).length;
  const byChars = chars / 3.6;
  const byWords = words * 1.35;
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const base = Math.max(byChars, byWords) + cjk * 0.6;
  return Math.ceil(base * SAFETY_MARGIN);
}

let o200k: { encode(t: string): number[] } | null = null;
let cl100k: { encode(t: string): number[] } | null = null;

async function encodeCount(text: string, kind: TokenizerKind): Promise<number> {
  try {
    if (kind === "o200k") {
      o200k ??= (await import("gpt-tokenizer/encoding/o200k_base")) as { encode(t: string): number[] };
      return o200k.encode(text).length;
    }
    if (kind === "cl100k") {
      cl100k ??= (await import("gpt-tokenizer/encoding/cl100k_base")) as { encode(t: string): number[] };
      return cl100k.encode(text).length;
    }
  } catch {
    /* tokenizer unavailable → heuristic */
  }
  return heuristicCount(text);
}

export function messageText(m: ModelMessage): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const out: string[] = [];
  for (const part of c as unknown as Array<Record<string, unknown>>) {
    const t = part["type"];
    if (t === "text" || t === "reasoning") out.push(String(part["text"] ?? ""));
    else if (t === "tool-call") out.push(JSON.stringify(part["input"] ?? part["args"] ?? ""));
    else if (t === "tool-result") out.push(JSON.stringify(part["output"] ?? part["result"] ?? ""));
  }
  return out.join("\n");
}

export async function estimateMessages(messages: ModelMessage[], model: string): Promise<number> {
  const kind = pickTokenizer(model);
  let sum = 0;
  for (const m of messages) {
    sum += await encodeCount(messageText(m), kind);
    sum += PER_MESSAGE_OVERHEAD;
  }
  return sum;
}

export function toUsage(u: unknown): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const anyU = u as Record<string, number>;
  return {
    inputTokens: anyU["inputTokens"],
    outputTokens: anyU["outputTokens"],
    totalTokens: anyU["totalTokens"],
  };
}

export interface TokenBudget {
  window: number;
  softPct: number;
  hardPct: number;
}
export interface OverflowResult {
  soft: boolean;
  hard: boolean;
  ratio: number;
  effective: number;
}

export function isOverflow(localEstimate: number, providerUsage: number | null, budget: TokenBudget): OverflowResult {
  const effective = Math.max(localEstimate, providerUsage ?? 0);
  const ratio = budget.window > 0 ? effective / budget.window : 0;
  return {
    soft: effective >= budget.softPct * budget.window,
    hard: effective >= budget.hardPct * budget.window,
    ratio,
    effective,
  };
}

/**
 * Extract provider-reported **context fill** from AI SDK step results for dual-trigger
 * overflow (Hermes: trust real usage when larger than local estimate).
 *
 * Uses the **last** step with finite input/prompt tokens so post-compaction steps
 * are not permanently sticky from a pre-compact max. Falls back to last totalTokens
 * only when input/prompt is missing.
 */
export function providerUsageFromSteps(
  steps: ReadonlyArray<{ usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; promptTokens?: number } }> | null | undefined,
): number | null {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const u = steps[i]?.usage;
    if (!u || typeof u !== "object") continue;
    const input = Number(u.inputTokens ?? u.promptTokens);
    if (Number.isFinite(input) && input > 0) return input;
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const u = steps[i]?.usage;
    if (!u || typeof u !== "object") continue;
    const total = Number(u.totalTokens);
    if (Number.isFinite(total) && total > 0) return total;
  }
  return null;
}
