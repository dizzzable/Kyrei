/**
 * Deterministic eval harness (Requirements §12.5, §13). Drives the REAL engine
 * loop (streamText + tools + stream-bridge) with a scripted MockLanguageModelV4
 * in a temp workspace, then checks a machine oracle. No network, no flakiness.
 */

import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamText, isStepCount, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { buildTools, type ToolMeta } from "../../core/engine/tools/index.js";
import { bridgeStream } from "../../core/engine/stream-bridge/bridge.js";
import { DEFAULT_ENGINE_CONFIG } from "../../core/engine/types.js";

/**
 * What an eval task is exercising.
 *
 * Reported per category, because a single pass rate hides which capability
 * moved: a change that fixes editing while quietly loosening the path jail
 * shows up as "still 100%".
 */
export type EvalCategory =
  | "edit" // a well-formed edit must land, byte-exactly
  | "reject" // a malformed or ambiguous edit must be refused, workspace untouched
  | "safety" // path jail, secret handling — refusal is the correct outcome
  | "intel" // the project index the agent reasons about dependencies with
  | "search" // read/grep/find surfaces
  | "recover"; // the agent gets a failure and must be able to act on it

export interface EvalTask {
  id: string;
  category: EvalCategory;
  /** Why this task exists — normally the real defect it would have caught. */
  rationale: string;
  prompt: string;
  seed?: Record<string, string>; // relative path → content
  /** Per-step model stream chunks (step 0 typically calls tools; last emits finish/stop). */
  script: unknown[][];
  /** Machine oracle: returns true if the task succeeded. */
  oracle: (ws: string, run: EvalRun) => Promise<boolean>;
}

/**
 * What the run actually did, for oracles that need more than the filesystem.
 *
 * A refusal is not an exception here — the tools return a denial as a normal
 * result the model can read and act on. So "nothing was written" is not enough
 * evidence that a guard fired: a tool that silently did nothing would pass that
 * check too. An oracle has to be able to see that the refusal was REPORTED.
 */
export interface EvalRun {
  /** Text of every tool result, in call order. */
  toolOutputs: string[];
  /** Tool calls that surfaced an error part. */
  toolErrors: number;
  toolStarts: number;
}

export interface EvalMetrics {
  id: string;
  category: EvalCategory;
  editSuccess: boolean;
  steps: number;
  tokens: number;
  toolErrorRate: number;
  wallMs: number;
}

function scriptedModel(script: unknown[][]): MockLanguageModelV4 {
  let i = 0;
  return new MockLanguageModelV4({
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
      stopWhen: isStepCount(6),
    });
    const toolOutputs: string[] = [];
    const bridged = await bridgeStream(result.stream, (e) => {
      if (e.type === "tool.start") toolStarts++;
      else if (e.type === "tool.complete") {
        if (e.payload.error) toolErrors++;
        const payload = e.payload as { error?: unknown; output?: unknown; result?: unknown };
        toolOutputs.push(String(payload.error ?? payload.output ?? payload.result ?? ""));
      }
    }, { toolMeta: new Map(), provider: "mock", model: "mock", maxSteps: 6 });
    steps = (bridged.parts.filter((p) => p.type === "tool").length || 0) + 1;
    tokens = bridged.usage?.totalTokens ?? 0;
    const editSuccess = await task.oracle(ws, { toolOutputs, toolErrors, toolStarts });
    return {
      id: task.id,
      category: task.category,
      editSuccess,
      steps,
      tokens,
      toolErrorRate: toolStarts ? toolErrors / toolStarts : 0,
      wallMs: Date.now() - started,
    };
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
/** Byte-exact comparison — the oracle for "the refusal left the file alone". */
export async function fileEquals(ws: string, rel: string, expected: string): Promise<boolean> {
  try {
    return (await readFile(join(ws, rel), "utf8")) === expected;
  } catch {
    return false;
  }
}
/** Read the persisted project index, or null when the tool never wrote one. */
export async function readProjectIndex(ws: string): Promise<{
  nodes: Array<{ path: string }>;
  edges: Array<{ from: string; to: string }>;
} | null> {
  try {
    return JSON.parse(await readFile(join(ws, ".kyrei", "intel", "project-index.json"), "utf8"));
  } catch {
    return null;
  }
}
/** True when the index records an import edge between two workspace files. */
export async function hasImportEdge(ws: string, from: string, to: string): Promise<boolean> {
  const index = await readProjectIndex(ws);
  return Boolean(index?.edges.some((edge) => edge.from === from && edge.to === to));
}
