/**
 * prepareStep hook: compacts context on the soft-budget threshold by pruning
 * large tool outputs (reversible via CCR). Runs rarely (only on overflow) to
 * preserve prompt-cache stability. Requirements §5.2, §5.5.
 */

import type { ModelMessage } from "ai";
import type { EngineConfig } from "../types.js";
import type { CcrStore } from "../context/ccr.js";
import { estimateMessages, isOverflow } from "../context/tokens.js";
import { pruneToolOutputs, DEFAULT_PRUNE } from "../context/compaction.js";

export type PrepareStep = (opts: { messages: ModelMessage[] }) => Promise<{ messages: ModelMessage[] } | undefined>;

export function makePrepareStep(cfg: EngineConfig, model: string, window: number, ccr: CcrStore): PrepareStep {
  return async ({ messages }) => {
    const est = await estimateMessages(messages, model);
    const of = isOverflow(est, null, { window, softPct: cfg.contextBudget.softPct, hardPct: cfg.contextBudget.hardPct });
    if (!of.soft) return undefined;
    const pruneCfg = { ...DEFAULT_PRUNE, maxToolOutputChars: cfg.maxToolOutput };
    const { messages: pruned, prunedCount } = await pruneToolOutputs(messages, ccr, pruneCfg);
    return prunedCount > 0 ? { messages: pruned } : undefined;
  };
}
