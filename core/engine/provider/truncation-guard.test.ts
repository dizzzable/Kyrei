import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamText, isStepCount, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { buildTools, type ToolMeta } from "../tools/index.js";
import { bridgeStream } from "../stream-bridge/bridge.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";
import { createTruncationSignal, withTruncationGuard, TRUNCATED_TURN_REFUSAL } from "./truncation-guard.js";

const usage = { inputTokens: { total: 20, noCache: 20 }, outputTokens: { total: 10, text: 10 } };

/** One assistant step that calls `write_file` and finishes for `reason`. */
function scripted(reason: unknown) {
  const chunks = [
    { type: "tool-call", toolCallId: "c1", toolName: "write_file", input: JSON.stringify({ path: "a.txt", content: "TRUNCA" }) },
    { type: "finish", finishReason: reason, usage },
  ];
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: chunks as never[] }) }),
  });
}

/** Run one turn the way `run.ts` wires it, and report what the file holds after. */
async function runTurn(reason: unknown): Promise<{ content: string; outputs: string[] }> {
  const ws = await mkdtemp(join(tmpdir(), "kyrei-truncation-"));
  try {
    await writeFile(join(ws, "a.txt"), "ORIGINAL\n", "utf8");
    const truncation = createTruncationSignal();
    const tools = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map<string, ToolMeta>(), {
      isTurnTruncated: () => truncation.truncated,
    });
    const result = streamText({
      model: withTruncationGuard(scripted(reason), truncation),
      messages: [{ role: "user", content: "go" }],
      tools,
      stopWhen: isStepCount(2),
    });
    const outputs: string[] = [];
    await bridgeStream(result.stream, (event) => {
      if (event.type === "tool.complete") {
        outputs.push(String((event.payload as { result?: unknown }).result ?? ""));
      }
    }, { toolMeta: new Map(), provider: "mock", model: "mock", maxSteps: 2 });
    return { content: await readFile(join(ws, "a.txt"), "utf8"), outputs };
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
}

describe("truncated responses must not execute tool calls", () => {
  it("refuses a mutating call when the model hit the output token limit", async () => {
    // Reproduced against the real tool loop before this guard existed: a
    // `write_file` truncated to {"path":"a.txt","content":"TRUNCA"} parsed,
    // validated and RAN, turning a file containing ORIGINAL into TRUNCA. The
    // model had been cut off mid-sentence; the write looked complete.
    const { content, outputs } = await runTurn({ unified: "length", raw: "max_tokens" });
    expect(content).toBe("ORIGINAL\n");
    expect(outputs.join(" ")).toContain(TRUNCATED_TURN_REFUSAL);
  }, 60_000);

  it("reads the stop reason in either shape providers report", async () => {
    // Getting this wrong fails OPEN — the guard silently never fires and the
    // corruption looks like a model mistake — so both the bare string and the
    // {unified, raw} object are handled.
    expect((await runTurn("length")).content).toBe("ORIGINAL\n");
    expect((await runTurn({ unified: "other", raw: "MAX_TOKENS" })).content).toBe("ORIGINAL\n");
  }, 60_000);

  it("leaves a normally finished call alone", async () => {
    // The guard must not become a blanket refusal.
    const { content } = await runTurn({ unified: "tool-calls", raw: "tool_use" });
    expect(content).toBe("TRUNCA");
  }, 60_000);
});
