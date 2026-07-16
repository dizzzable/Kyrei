import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel, ToolSet } from "ai";
import type { DelegateProgress } from "./delegate.js";

const { generateTextMock, isStepCountMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  isStepCountMock: vi.fn((steps: number) => ({ steps })),
}));

vi.mock("ai", () => ({
  generateText: generateTextMock,
  isStepCount: isStepCountMock,
}));

import {
  buildReadOnlyChildInstructions,
  createReadOnlyChildRunner,
  selectReadOnlyChildTools,
} from "./read-child.js";

function definitions(...names: string[]): ToolSet {
  return Object.fromEntries(names.map((name) => [name, { name }])) as unknown as ToolSet;
}

describe("read-only child runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects capabilities by allowlist and excludes every mutating or recursive tool", () => {
    const selected = selectReadOnlyChildTools(
      definitions(
        "list_dir",
        "read_file",
        "write_file",
        "edit_file",
        "run_command",
        "diagnostics",
        "project_index",
        "project_map",
        "delegate_read",
      ),
      definitions(
        "web_search",
        "web_fetch",
        "brain_search",
        "brain_capture",
        "query_decisions",
        "record_decision",
        "plan_read",
        "plan_write_roadmap",
        "openviking_find",
        "openviking_add_message",
        "search_skills",
        "read_skill",
        "read_skill_document",
        "search_skill_documents",
        "approval",
      ),
    );

    expect(Object.keys(selected).sort()).toEqual([
      "brain_search",
      "list_dir",
      "openviking_find",
      "plan_read",
      "project_map",
      "query_decisions",
      "read_file",
      "read_skill",
      "read_skill_document",
      "search_skill_documents",
      "search_skills",
      "web_fetch",
      "web_search",
    ]);
    expect(selected).not.toHaveProperty("write_file");
    expect(selected).not.toHaveProperty("project_index");
    expect(selected).not.toHaveProperty("brain_capture");
    expect(selected).not.toHaveProperty("record_decision");
    expect(selected).not.toHaveProperty("plan_write_roadmap");
    expect(selected).not.toHaveProperty("openviking_add_message");
    expect(selected).not.toHaveProperty("delegate_read");
  });

  it("builds an isolated prompt with bounded skill metadata and explicit safety", () => {
    const instructions = buildReadOnlyChildInstructions("C:/repo", [
      { id: "review", name: "Code review", description: "Inspect changes" },
    ]);

    expect(instructions).toContain("read-only research subagent");
    expect(instructions).toContain("must not write files");
    expect(instructions).toContain("delegate to another agent");
    expect(instructions).toContain("search_skills");
    expect(instructions).toContain("review: Code review - Inspect changes");
    expect(instructions).toContain("language of the goal");
  });

  it("uses the supplied parent model and reports real usage, tools, and files", async () => {
    generateTextMock.mockImplementationOnce(async (options: Record<string, unknown>) => {
      const onToolExecutionStart = options["onToolExecutionStart"] as (event: unknown) => void;
      const onStepEnd = options["onStepEnd"] as (event: unknown) => void;
      onToolExecutionStart({
        toolCall: { toolName: "read_file", input: { path: "src\\a.ts" } },
      });
      onToolExecutionStart({
        toolCall: {
          toolName: "batch",
          input: {
            calls: [
              { tool: "read_file", args: { path: "src/b.ts" } },
              { tool: "grep_search", args: { query: "needle" } },
            ],
          },
        },
      });
      onStepEnd({
        stepNumber: 0,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      });
      return {
        text: "  Found the evidence.  ",
        steps: [{ text: "" }],
        toolCalls: [{}, {}],
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      };
    });

    const model = { id: "same-parent-model" } as unknown as LanguageModel;
    const tools = definitions("read_file", "batch", "web_search", "read_skill");
    const controller = new AbortController();
    const progress: DelegateProgress[] = [];
    const runner = createReadOnlyChildRunner({
      model,
      modelId: "model-1",
      tools,
      maxSteps: 5,
      maxRetries: 2,
      cost: { inputPerM: 1, outputPerM: 2 },
      providerOptions: { kyrei: { reasoningEffort: "low" } },
      workspace: "C:/repo",
      skills: [{ id: "review", name: "Review", description: "Review code" }],
    });

    const result = await runner({
      childId: "child-1",
      goal: "Find evidence",
      index: 0,
      signal: controller.signal,
      readOnly: true,
      allowDelegation: false,
      onProgress: (update) => progress.push(update),
    });

    expect(isStepCountMock).toHaveBeenCalledWith(5);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls[0]?.[0]).toMatchObject({
      model,
      prompt: "Find evidence",
      tools,
      abortSignal: controller.signal,
      maxRetries: 2,
      providerOptions: { kyrei: { reasoningEffort: "low" } },
    });
    expect(result).toEqual({
      summary: "Found the evidence.",
      model: "model-1",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        costUsd: 0.00014,
      },
      toolCount: 2,
      providerCalls: 1,
      filesRead: ["src/a.ts", "src/b.ts"],
      filesWritten: [],
    });
    expect(progress).toHaveLength(3);
    expect(progress.at(-1)).toMatchObject({
      text: "Research step 1 complete",
      model: "model-1",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.00014 },
      toolCount: 2,
      providerCalls: 1,
      filesRead: ["src/a.ts", "src/b.ts"],
    });
  });

  it("spends one tool-free continuation on a missing child summary", async () => {
    generateTextMock
      .mockResolvedValueOnce({
        text: "",
        steps: [{ text: "" }],
        toolCalls: [{ toolName: "read_file" }],
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        responseMessages: [{ role: "assistant", content: [] }],
      })
      .mockResolvedValueOnce({
        text: "The requested evidence is in src/agent.ts; no contradiction was found.",
        steps: [{ text: "The requested evidence is in src/agent.ts; no contradiction was found." }],
        toolCalls: [],
        usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
        responseMessages: [],
      });

    const model = { id: "same-parent-model" } as unknown as LanguageModel;
    const controller = new AbortController();
    const progress: DelegateProgress[] = [];
    const runner = createReadOnlyChildRunner({
      model,
      modelId: "model-1",
      tools: definitions("read_file"),
      maxSteps: 3,
      maxRetries: 2,
      cost: { inputPerM: 1, outputPerM: 2 },
    });

    const result = await runner({
      childId: "child-synthesis",
      goal: "Find the evidence",
      index: 0,
      signal: controller.signal,
      readOnly: true,
      allowDelegation: false,
      onProgress: (update) => progress.push(update),
    });

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    const synthesisCall = generateTextMock.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(synthesisCall).toMatchObject({
      model,
      abortSignal: controller.signal,
      maxRetries: 0,
    });
    expect(synthesisCall["instructions"]).toContain("Do not call tools.");
    expect(synthesisCall).not.toHaveProperty("tools");
    expect(synthesisCall).not.toHaveProperty("stopWhen");
    expect(result).toMatchObject({
      summary: "The requested evidence is in src/agent.ts; no contradiction was found.",
      toolCount: 1,
      providerCalls: 2,
      usage: { inputTokens: 130, outputTokens: 32, totalTokens: 162, costUsd: 0.000194 },
    });
    expect(progress.some((update) => typeof update !== "string" && update.text === "Preparing final research summary")).toBe(true);
  });

  it("returns an explicit non-evidence result when a child cannot be synthesized", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "",
      steps: [{ text: "" }],
      toolCalls: [{ toolName: "read_file" }],
      usage: {},
      responseMessages: [],
    });

    const runner = createReadOnlyChildRunner({
      model: { id: "worker-model" } as unknown as LanguageModel,
      modelId: "worker-model",
      tools: definitions("read_file"),
      maxSteps: 2,
      maxRetries: 0,
      cost: { inputPerM: 0, outputPerM: 0 },
    });
    const result = await runner({
      childId: "child-incomplete",
      goal: "Find the evidence",
      index: 0,
      readOnly: true,
      allowDelegation: false,
      onProgress: () => undefined,
    });

    expect(generateTextMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      incomplete: true,
      toolCount: 1,
      summary: expect.stringContaining("Treat this as non-evidence"),
    });
  });

  it("acquires immediately before the provider call and releases the lease once on success", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "Account-scoped evidence",
      steps: [{ text: "Account-scoped evidence" }],
      toolCalls: [],
      usage: {},
    });
    const handle = { lease: "worker-1" };
    const acquire = vi.fn(() => handle);
    const release = vi.fn();
    const runner = createReadOnlyChildRunner({
      model: { id: "worker-model" } as unknown as LanguageModel,
      modelId: "worker-model",
      tools: {},
      maxSteps: 2,
      maxRetries: 0,
      cost: { inputPerM: 0, outputPerM: 0 },
      providerAttempt: {
        lifecycle: { acquire, release },
        target: { providerId: "worker-provider", accountId: "reserve", modelId: "worker-model" },
      },
    });

    await runner({
      childId: "child-account",
      goal: "Inspect the account route",
      index: 0,
      readOnly: true,
      allowDelegation: false,
      onProgress: () => undefined,
    });

    expect(acquire).toHaveBeenCalledOnce();
    expect(acquire).toHaveBeenCalledWith({
      providerId: "worker-provider",
      accountId: "reserve",
      modelId: "worker-model",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(handle, {
      providerId: "worker-provider",
      accountId: "reserve",
      modelId: "worker-model",
      outcome: "success",
      phase: "stream",
    });
  });

  it("fails closed before generateText when the selected account has no capacity", async () => {
    const acquire = vi.fn(() => null);
    const release = vi.fn();
    const runner = createReadOnlyChildRunner({
      model: { id: "worker-model" } as unknown as LanguageModel,
      modelId: "worker-model",
      tools: {},
      maxSteps: 2,
      maxRetries: 0,
      cost: { inputPerM: 0, outputPerM: 0 },
      providerAttempt: {
        lifecycle: { acquire, release },
        target: { providerId: "worker-provider", accountId: "busy", modelId: "worker-model" },
      },
    });

    await expect(runner({
      childId: "child-capacity",
      goal: "Do not call the provider",
      index: 0,
      readOnly: true,
      allowDelegation: false,
      onProgress: () => undefined,
    })).rejects.toMatchObject({
      message: "provider_capacity_unavailable",
      code: "provider_capacity_unavailable",
    });
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("releases a failed provider call once with bounded retry telemetry", async () => {
    const providerError = Object.assign(new Error("rate limited"), {
      status: 429,
      headers: { "Retry-After": "2" },
    });
    generateTextMock.mockRejectedValueOnce(providerError);
    const handle = { lease: "worker-429" };
    const acquire = vi.fn(() => handle);
    const release = vi.fn();
    const runner = createReadOnlyChildRunner({
      model: { id: "worker-model" } as unknown as LanguageModel,
      modelId: "worker-model",
      tools: {},
      maxSteps: 2,
      maxRetries: 0,
      cost: { inputPerM: 0, outputPerM: 0 },
      providerAttempt: {
        lifecycle: { acquire, release },
        target: { providerId: "worker-provider", accountId: "limited", modelId: "worker-model" },
      },
    });

    await expect(runner({
      childId: "child-limited",
      goal: "Call the provider once",
      index: 0,
      readOnly: true,
      allowDelegation: false,
      onProgress: () => undefined,
    })).rejects.toBe(providerError);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(handle, {
      providerId: "worker-provider",
      accountId: "limited",
      modelId: "worker-model",
      outcome: "retryable-error",
      phase: "stream",
      statusCode: 429,
      retryAfterMs: 2_000,
    });
  });

  it("treats a late resolved result as interrupted after cancellation", async () => {
    const controller = new AbortController();
    generateTextMock.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled while provider ignored the signal"));
      return {
        text: "late result",
        finishReason: "stop",
        steps: [],
        toolCalls: [],
        usage: {},
      };
    });
    const handle = { lease: "worker-cancelled" };
    const acquire = vi.fn(() => handle);
    const release = vi.fn();
    const runner = createReadOnlyChildRunner({
      model: { id: "worker-model" } as unknown as LanguageModel,
      modelId: "worker-model",
      tools: {},
      maxSteps: 2,
      maxRetries: 0,
      cost: { inputPerM: 0, outputPerM: 0 },
      providerAttempt: {
        lifecycle: { acquire, release },
        target: { providerId: "worker-provider", accountId: "cancelled", modelId: "worker-model" },
      },
    });

    await expect(runner({
      childId: "child-cancelled",
      goal: "Ignore a late result",
      index: 0,
      readOnly: true,
      allowDelegation: false,
      signal: controller.signal,
      onProgress: () => undefined,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(handle, {
      providerId: "worker-provider",
      accountId: "cancelled",
      modelId: "worker-model",
      outcome: "interrupted",
      phase: "stream",
    });
  });

  it("enforces a wall-clock timeout even when the provider ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      let providerSignal: AbortSignal | undefined;
      let rejectLate: ((error: Error) => void) | undefined;
      generateTextMock.mockImplementationOnce((options: Record<string, unknown>) => {
        providerSignal = options["abortSignal"] as AbortSignal;
        return new Promise((_resolve, reject) => {
          rejectLate = reject;
        });
      });
      const handle = { lease: "worker-timeout" };
      const acquire = vi.fn(() => handle);
      const release = vi.fn();
      const runner = createReadOnlyChildRunner({
        model: { id: "slow-worker" } as unknown as LanguageModel,
        modelId: "slow-worker",
        tools: {},
        maxSteps: 2,
        maxRetries: 0,
        timeoutMs: 1_000,
        cost: { inputPerM: 0, outputPerM: 0 },
        providerAttempt: {
          lifecycle: { acquire, release },
          target: { providerId: "worker-provider", accountId: "timeout", modelId: "slow-worker" },
        },
      });

      const pending = runner({
        childId: "child-timeout",
        goal: "Do not hang the parent",
        index: 0,
        readOnly: true,
        allowDelegation: false,
        onProgress: () => undefined,
      });
      const rejected = expect(pending).rejects.toMatchObject({
        name: "TimeoutError",
        code: "delegation_timeout",
        timeoutMs: 1_000,
        message: "Delegated research timed out after 1000ms",
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(providerSignal?.aborted).toBe(true);
      // The provider ignored the cancellation; its physical request is still
      // in flight, so its account lease must remain occupied.
      expect(release).not.toHaveBeenCalled();

      rejectLate?.(new Error("late provider failure"));
      await vi.runAllTicks();
      expect(release).toHaveBeenCalledWith(handle, {
        providerId: "worker-provider",
        accountId: "timeout",
        modelId: "slow-worker",
        outcome: "interrupted",
        phase: "stream",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates an external abort distinctly from a child timeout", async () => {
    let providerSignal: AbortSignal | undefined;
    let resolveLate: ((value: unknown) => void) | undefined;
    generateTextMock.mockImplementationOnce((options: Record<string, unknown>) => {
      providerSignal = options["abortSignal"] as AbortSignal;
      return new Promise((resolve) => {
        resolveLate = resolve;
      });
    });
    const controller = new AbortController();
    const runner = createReadOnlyChildRunner({
      model: { id: "slow-worker" } as unknown as LanguageModel,
      modelId: "slow-worker",
      tools: {},
      maxSteps: 2,
      maxRetries: 0,
      timeoutMs: 30_000,
      cost: { inputPerM: 0, outputPerM: 0 },
    });

    const pending = runner({
      childId: "child-parent-abort",
      goal: "Stop with the parent",
      index: 0,
      signal: controller.signal,
      readOnly: true,
      allowDelegation: false,
      onProgress: () => undefined,
    });
    controller.abort(new Error("parent stopped"));

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "parent stopped",
    });
    expect(providerSignal?.aborted).toBe(true);

    resolveLate?.({ text: "too late", steps: [], toolCalls: [], usage: {} });
    await Promise.resolve();
  });

  it("does not report a resolved terminal finish reason as account success", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "",
      finishReason: "error",
      steps: [],
      toolCalls: [],
      usage: {},
    });
    const handle = { lease: "worker-terminal" };
    const acquire = vi.fn(() => handle);
    const release = vi.fn();
    const runner = createReadOnlyChildRunner({
      model: { id: "worker-model" } as unknown as LanguageModel,
      modelId: "worker-model",
      tools: {},
      maxSteps: 2,
      maxRetries: 0,
      cost: { inputPerM: 0, outputPerM: 0 },
      providerAttempt: {
        lifecycle: { acquire, release },
        target: { providerId: "worker-provider", accountId: "terminal", modelId: "worker-model" },
      },
    });

    await expect(runner({
      childId: "child-terminal",
      goal: "Observe terminal status",
      index: 0,
      readOnly: true,
      allowDelegation: false,
      onProgress: () => undefined,
    })).rejects.toMatchObject({ code: "provider_generation_error" });
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(handle, {
      providerId: "worker-provider",
      accountId: "terminal",
      modelId: "worker-model",
      outcome: "terminal-error",
      phase: "stream",
    });
  });
});
