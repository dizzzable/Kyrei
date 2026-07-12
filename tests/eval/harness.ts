/**
 * Deterministic eval harness (Requirements §12.5, §13). Drives the REAL engine
 * loop (streamText + tools + stream-bridge) with a scripted MockLanguageModelV2
 * in a temp workspace, then checks a machine oracle. No network, no flakiness.
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamText, stepCountIs, simulateReadableStream } from "ai";
import { MockLanguageModelV2 } from "ai/test";
import { buildTools, type ToolMeta } from "../../core/engine/tools/index.js";
import { bridgeStream } from "../../core/engine/stream-bridge/bridge.js";
import { DEFAULT_ENGINE_CONFIG } from "../../core/engine/types.js";

export interface EvalTask {
  id: string;
  prompt: string;
  seed?: Record<string, string>; // relative path → content
  /** Per-step model stream chunks (step 0 typically calls tools; last emits finish/stop). */
  script: unknown[][];
  /** Machine oracle: returns true if the task succeeded. */
  oracle: (ws: string) => Promise<boolean>;
}

export interface EvalMetrics {
  id: string;
  editSuccess: boolean;
  steps: number;
  tokens: number;
  toolErrorRate: number;
  wallMs: number;
}

function scriptedModel(script: unknown[][]): MockLanguageModelV2 {
  let i = 0;
  return new MockLanguageModelV2({
    doStream: async () => {
      const chunks = script[Math.min(i, script.length - 1)] ?? [];
      i++;
      return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
    },
  });
}

export async function runEvalTask(task: EvalTask): Promise<EvalMetrics> {
  const ws = await mkdtemp(join(tmpdir(), `kyrei-eval-${task.id}-`));
  const started = Date.now();
  let toolStarts = 0;
  let toolErrors = 0;
  let steps = 0;
  let tokens = 0;
  try {
    for (const [rel, content] of Object.entries(task.seed ?? {})) {
      const abs = join(ws, rel);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, content, "utf8");
    }
    const tools = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map<string, ToolMeta>());
    const result = streamText({
      model: scriptedModel(task.script),
      messages: [{ role: "user", content: task.prompt }],
      tools,
      stopWhen: stepCountIs(6),
    });
    const bridged = await bridgeStream(result.fullStream, (e) => {
      if (e.type === "tool.start") toolStarts++;
      else if (e.type === "tool.complete" && e.payload.error) toolErrors++;
    }, { toolMeta: new Map(), provider: "mock", model: "mock", maxSteps: 6 });
    steps = (bridged.parts.filter((p) => p.type === "tool").length || 0) + 1;
    tokens = bridged.usage?.totalTokens ?? 0;
    const editSuccess = await task.oracle(ws);
    return { id: task.id, editSuccess, steps, tokens, toolErrorRate: toolStarts ? toolErrors / toolStarts : 0, wallMs: Date.now() - started };
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

export async function fileExists(ws: string, rel: string): Promise<boolean> {
  try {
    await readFile(join(ws, rel), "utf8");
    return true;
  } catch {
    return false;
  }
}
export async function fileContains(ws: string, rel: string, needle: string): Promise<boolean> {
  try {
    return (await readFile(join(ws, rel), "utf8")).includes(needle);
  } catch {
    return false;
  }
}
