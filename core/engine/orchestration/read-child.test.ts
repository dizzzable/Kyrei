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
      definitions("web_search", "web_fetch", "brain_search", "brain_capture", "read_skill", "approval"),
    );

    expect(Object.keys(selected).sort()).toEqual([
      "brain_search",
      "list_dir",
      "project_map",
      "read_file",
      "read_skill",
      "web_fetch",
      "web_search",
    ]);
    expect(selected).not.toHaveProperty("write_file");
    expect(selected).not.toHaveProperty("project_index");
    expect(selected).not.toHaveProperty("brain_capture");
    expect(selected).not.toHaveProperty("delegate_read");
  });

  it("builds an isolated prompt with bounded skill metadata and explicit safety", () => {
    const instructions = buildReadOnlyChildInstructions("C:/repo", [
      { id: "review", name: "Code review", description: "Inspect changes" },
    ]);

    expect(instructions).toContain("read-only research subagent");
    expect(instructions).toContain("must not write files");
    expect(instructions).toContain("delegate to another agent");
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
