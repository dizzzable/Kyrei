import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";

import { buildTools } from "./index.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";

let ws = "";

const ALLOW_NODE_EVAL = {
  ...DEFAULT_ENGINE_CONFIG,
  permissions: {
    ...DEFAULT_ENGINE_CONFIG.permissions,
    terminal: "auto" as const,
  },
};

async function exec(tools: ToolSet, name: string, args: unknown, toolCallId = "t"): Promise<string> {
  const tool = tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> };
  return String(await tool.execute(args, { toolCallId, messages: [] }));
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "kyrei-tool-failure-"));
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true }).catch(() => {});
});

describe("a failing tool obeys the same output budget as a succeeding one", () => {
  // Regression: `safeClip` (redact + smart clip) ran only on the success path.
  // A failing `run_command` rejects with its entire captured output, bounded
  // only by RUN_COMMAND_MAX_BUFFER (512_000) — so the most frequent failure in
  // a coding loop (a red test run, a tsc sweep) could push ~128k tokens of
  // UNREDACTED text into the model's history.
  const hugeFailure = (secret: string) => {
    const runner = {
      run: vi.fn(async () => {
        throw new Error(`Command exited with code 1\n${secret}\n${"x".repeat(400_000)}`);
      }),
    };
    return runner;
  };

  it("clips a rejected command's message to maxToolOutput", async () => {
    const commandRunner = hugeFailure("harmless");
    const tools = buildTools(ws, ALLOW_NODE_EVAL, new Map(), {
      sessionId: "s",
      actorId: "main",
      commandRunner,
    });

    await expect(exec(tools, "run_command", { command: `npm test` }))
      .rejects.toSatisfy((error: Error) => {
        expect(error.message.length).toBeLessThanOrEqual(DEFAULT_ENGINE_CONFIG.maxToolOutput + 2_000);
        // The head of the message — the part that says what failed — survives.
        expect(error.message).toContain("Command exited with code 1");
        return true;
      });
  });

  it("redacts a secret the failing command printed", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345";
    const commandRunner = hugeFailure(secret);
    const tools = buildTools(ws, ALLOW_NODE_EVAL, new Map(), {
      sessionId: "s",
      actorId: "main",
      commandRunner,
      sensitiveValues: ["super-secret-runtime-value"],
    });

    await expect(exec(tools, "run_command", { command: `npm test` }))
      .rejects.toSatisfy((error: Error) => {
        expect(error.message).not.toContain(secret);
        // Absence alone would also hold if the message were merely truncated
        // before the secret. The placeholder proves redaction actually ran.
        expect(error.message).toContain("[REDACTED]");
        return true;
      });
  });

  it("redacts runtime sensitive values on the error path", async () => {
    const apiKey = "super-secret-runtime-value";
    const commandRunner = {
      run: vi.fn(async () => { throw new Error(`auth failed using ${apiKey}`); }),
    };
    const tools = buildTools(ws, ALLOW_NODE_EVAL, new Map(), {
      sessionId: "s",
      actorId: "main",
      commandRunner,
      sensitiveValues: [apiKey],
    });

    await expect(exec(tools, "run_command", { command: `npm test` }))
      .rejects.toSatisfy((error: Error) => {
        expect(error.message).not.toContain(apiKey);
        return true;
      });
  });

  it("leaves an abort untouched so cancellation still reads as an abort", async () => {
    // Clipping an AbortError would be harmless but rewrapping it would not —
    // the turn distinguishes user cancellation from a tool failure by it.
    const controller = new AbortController();
    const commandRunner = {
      run: vi.fn(async () => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }),
    };
    const tools = buildTools(ws, ALLOW_NODE_EVAL, new Map(), {
      sessionId: "s",
      actorId: "main",
      commandRunner,
      abortSignal: controller.signal,
    });

    await expect(exec(tools, "run_command", { command: `npm test` }))
      .rejects.toSatisfy((error: Error) => {
        expect(error.name).toBe("AbortError");
        // Asserting only `.name` proved nothing — clipping never changes it,
        // so the test passed with the abort guard removed. The MESSAGE is what
        // the guard protects.
        expect(error.message).toBe("aborted");
        return true;
      });
  });

  it("survives an error whose message cannot be written", async () => {
    // DOMException.message is a getter-only accessor and ESM is strict mode, so
    // a bare assignment THROWS and replaces the real tool failure with
    // "Cannot set property message". AbortSignal.timeout produces one of these.
    const commandRunner = {
      run: vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }),
    };
    const tools = buildTools(ws, ALLOW_NODE_EVAL, new Map(), {
      sessionId: "s",
      actorId: "main",
      commandRunner,
    });

    await expect(exec(tools, "run_command", { command: `npm test` }))
      .rejects.toSatisfy((error: Error) => {
        expect(error.message).toBe("timed out");
        expect(error.message).not.toContain("Cannot set property");
        return true;
      });
  });
});

describe("edit_file distinguishes a malformed patch from a denied target", () => {
  // Regression: a patch that parsed to zero files returned the workspace-jail
  // denial string. The model then tried to change the PATH, which was never the
  // problem, instead of fixing the patch syntax — a guaranteed retry loop.
  it("explains the syntax problem and restates the format", async () => {
    const tools = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map());

    const out = await exec(tools, "edit_file", { patch: "please change the greeting to hello" });

    expect(out).not.toContain("outside the workspace");
    expect(out).toContain("could not parse the patch");
    expect(out).toContain("*** Update File:");
    // It must be unambiguous that nothing happened.
    expect(out).toMatch(/unchanged|nothing was executed/i);
  });

  it("names the empty-patch case specifically", async () => {
    const tools = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map());
    const out = await exec(tools, "edit_file", { patch: "   \n  " });
    expect(out).toContain("empty");
  });

  it("still reports a real jail violation as a denial", async () => {
    // The security message must remain for the case it actually describes.
    const tools = buildTools(ws, DEFAULT_ENGINE_CONFIG, new Map());
    await writeFile(join(ws, "inside.txt"), "one\n", "utf8");

    const out = await exec(tools, "edit_file", {
      patch: "*** Update File: ../escape.txt\n@@\n-one\n+two\n",
    });

    expect(out).toContain("outside the workspace");
  });
});
