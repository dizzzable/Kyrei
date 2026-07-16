/**
 * prepareStep hook: two-stage context compaction on soft/hard budget.
 * Stage A — prune large tool outputs (reversible via CCR).
 * Stage B — structured middle summary (model projection only; chat JSON SoT intact).
 * Also triggers heuristic handoff artifacts on checkpoint marks (20/45/70% soft).
 */

import type { ModelMessage } from "ai";
import type { LanguageModel } from "ai";
import type { EngineConfig } from "../types.js";
import type { CcrStore } from "../context/ccr.js";
import { estimateMessages, isOverflow, providerUsageFromSteps } from "../context/tokens.js";
import {
  pruneToolOutputs,
  DEFAULT_PRUNE,
  firedCheckpointMark,
  summarizeMiddleTurns,
} from "../context/compaction.js";
import { readContextSummary, writeContextSummary } from "../context/summary-store.js";
import { extractHeuristicHandoff, writeHandoff } from "../memory/handoff.js";
import { prepareMessagesForModel } from "../reliability/runtime.js";

export type PrepareStep = (opts: {
  messages: ModelMessage[];
  /** Prior stream steps (AI SDK); usage drives dual-trigger overflow. */
  steps?: ReadonlyArray<{ usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; promptTokens?: number } }>;
  stepNumber?: number;
}) => Promise<{ messages: ModelMessage[] } | undefined>;

export interface MakePrepareStepOptions {
  model: string;
  window: number;
  ccr: CcrStore;
  workspace?: string;
  sessionId?: string;
  /** When set (LTM enabled), a checkpoint is appended to the ledger alongside each handoff. */
  ltmDir?: string;
  /** Refresh rebuildable memory index after checkpoint handoff. */
  onMemoryMutated?: () => void;
  /**
   * Optional LanguageModel for stage-B LLM summary when compression.summaryUseLlm.
   * Fail-open to heuristic when missing/error.
   */
  summaryModel?: LanguageModel;
  /** Inject generateText for tests; defaults to dynamic import of "ai". */
  generateText?: typeof import("ai").generateText;
}

export function makePrepareStep(cfg: EngineConfig, opts: MakePrepareStepOptions): PrepareStep {
  const { model, window, ccr, workspace, sessionId, ltmDir, onMemoryMutated, summaryModel } = opts;
  const checkpointBudget = window * cfg.contextBudget.softPct;
  const firedMarks = new Set<number>();
  /** In-memory anti-thrash for this stream (also backed by summary file mtime). */
  let lastSummaryAt = 0;
  let hardSummaryForced = false;

  return async ({ messages, steps }) => {
    // Always drop dangling tool pairs before the next model request.
    let working = prepareMessagesForModel(messages);
    const est = await estimateMessages(working, model);
    // Dual-trigger: max(localEstimate, provider-reported usage from prior steps).
    const providerUsage = providerUsageFromSteps(steps);
    const of = isOverflow(est, providerUsage, {
      window,
      softPct: cfg.contextBudget.softPct,
      hardPct: cfg.contextBudget.hardPct,
    });

    // Check for checkpoint mark crossing (handoff trigger)
    if (workspace && sessionId && checkpointBudget > 0) {
      const mark = firedCheckpointMark(of.effective, checkpointBudget, firedMarks);
      if (mark !== null) {
        try {
          const handoff = extractHeuristicHandoff(working, sessionId, "window_limit");
          const path = await writeHandoff(workspace, handoff);
          console.info(`[kyrei] Checkpoint mark ${(mark * 100).toFixed(0)}% → handoff ${path}`);
          if (ltmDir) {
            try {
              const { createLtmBridge } = await import("../memory/ltm-bridge.js");
              const ltm = createLtmBridge(ltmDir);
              await ltm.appendCheckpoint({
                summary: `Context checkpoint at ${(mark * 100).toFixed(0)}% budget: ${handoff.intent}`,
                changedFiles: handoff.keyFiles.map((f) => f.path),
                decisions: [],
                openThreads: [],
                nextActions: handoff.nextActions,
                sessionId,
              });
              try {
                await ltm.refreshRuntimeSnapshot();
              } catch (snapErr) {
                console.warn("[kyrei] Failed to refresh LTM runtime snapshot:", snapErr);
              }
            } catch (ltmErr) {
              console.warn("[kyrei] Failed to append LTM checkpoint:", ltmErr);
            }
          }
          onMemoryMutated?.();
        } catch (err) {
          console.warn("[kyrei] Failed to write checkpoint handoff:", err);
        }
      }
    }

    const compression = cfg.compression ?? {
      enabled: true,
      protectLastN: 6,
      pruneToChars: 500,
      summaryEnabled: true,
      summaryUseLlm: false,
      protectFirstN: 2,
      summaryMinMessages: 12,
      summaryCooldownoffMs: 60_000,
    };

    if (!of.soft && !of.hard) {
      return working === messages ? undefined : { messages: working };
    }

    let changed = working !== messages;

    // Stage A — tool prune (soft or hard). Can disable via compression.enabled.
    if (compression.enabled !== false) {
      const keepLast = of.hard
        ? Math.max(2, Math.floor((compression.protectLastN ?? 6) / 2))
        : (compression.protectLastN ?? DEFAULT_PRUNE.keepLastMessages);
      const pruneCfg = {
        ...DEFAULT_PRUNE,
        maxToolOutputChars: of.hard
          ? Math.min(cfg.maxToolOutput, 4_000)
          : cfg.maxToolOutput,
        keepLastMessages: keepLast,
        pruneToChars: of.hard
          ? Math.min(compression.pruneToChars ?? 500, 300)
          : (compression.pruneToChars ?? DEFAULT_PRUNE.pruneToChars),
      };
      const { messages: pruned, prunedCount } = await pruneToolOutputs(working, ccr, pruneCfg);
      if (prunedCount > 0) {
        working = prepareMessagesForModel(pruned);
        changed = true;
      }
    }

    // Re-estimate after prune to decide stage B (keep provider usage in the max).
    const est2 = await estimateMessages(working, model);
    const of2 = isOverflow(est2, providerUsage, {
      window,
      softPct: cfg.contextBudget.softPct,
      hardPct: cfg.contextBudget.hardPct,
    });

    const wantSummary = compression.summaryEnabled !== false
      && (of2.soft || of2.hard || of.hard);

    if (wantSummary) {
      const now = Date.now();
      let prior = workspace && sessionId
        ? await readContextSummary(workspace, sessionId)
        : null;
      const priorAge = prior?.updatedAt ? now - Date.parse(prior.updatedAt) : Infinity;
      const cooldown = compression.summaryCooldownoffMs ?? 60_000;
      const inCooldown = (now - lastSummaryAt < cooldown)
        || (Number.isFinite(priorAge) && priorAge < cooldown);
      // Hard can force one summary past soft-only cooldown once per prepareStep closure.
      const allowDespiteCooldown = of.hard && !hardSummaryForced;

      if (!inCooldown || allowDespiteCooldown) {
        let llmSummarize: ((middleText: string, previous?: string) => Promise<string | null>) | undefined;
        if (compression.summaryUseLlm && summaryModel) {
          llmSummarize = async (middleText, previous) => {
            try {
              const generate = opts.generateText
                ?? (await import("ai")).generateText;
              const { text } = await generate({
                model: summaryModel,
                maxRetries: 0,
                maxOutputTokens: 1_200,
                messages: [
                  {
                    role: "system",
                    content: [
                      "You compress chat history for a coding agent.",
                      "Output a structured REFERENCE-ONLY summary (markdown).",
                      "Sections: Task snapshot, Done/actions, Open threads, Key files, Notes.",
                      "Do NOT invent secrets. Prefer latest user intent. No tool call instructions.",
                      "Keep under 900 tokens.",
                    ].join(" "),
                  },
                  {
                    role: "user",
                    content: [
                      previous ? `Previous summary:\n${previous.slice(0, 1_500)}\n\n` : "",
                      "Middle transcript to distill:\n",
                      middleText.slice(0, 20_000),
                    ].join(""),
                  },
                ],
              });
              const cleaned = String(text ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
              return cleaned.length >= 40 ? cleaned : null;
            } catch {
              return null;
            }
          };
        }

        const stageB = await summarizeMiddleTurns(working, {
          ccr,
          protect: {
            protectFirstN: compression.protectFirstN ?? 2,
            protectLastN: compression.protectLastN ?? 6,
            summaryMinMessages: compression.summaryMinMessages ?? 12,
          },
          previousSummary: prior?.summaryText,
          llmSummarize,
        });

        if (stageB.summarized && stageB.summaryText) {
          working = prepareMessagesForModel(stageB.messages);
          changed = true;
          lastSummaryAt = now;
          if (of.hard) hardSummaryForced = true;
          if (workspace && sessionId) {
            try {
              await writeContextSummary(workspace, {
                sessionId,
                updatedAt: new Date().toISOString(),
                via: stageB.via === "llm" ? "llm" : "heuristic",
                summaryText: stageB.summaryText,
                ...(stageB.middleCcrHash ? { middleCcrHash: stageB.middleCcrHash } : {}),
                sourceMessageCount: messages.length,
                charCount: stageB.summaryText.length,
              });
            } catch {
              /* best effort */
            }
          }
        }
      }
    }

    return changed ? { messages: working } : (working === messages ? undefined : { messages: working });
  };
}
