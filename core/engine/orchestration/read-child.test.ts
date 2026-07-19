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
    generateTextMock.mockReset();
    isStepCountMock.mockReset();
    isStepCountMock.mockImplementation((steps: number) => ({ steps }));
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

  it("keeps a large child Skill catalog discoverable without inlining it all", () => {
    const skills = Array.from({ length: 33 }, (_, index) => ({
      id: `skill-${index}`,
      name: `Skill ${index}`,
      description: `Domain ${index}`,
    }));
    const instructions = buildReadOnlyChildInstructions("C:/repo", skills);

    expect(instructions).toContain("catalog contains 33 entries; this prompt previews 32");
    expect(instructions).toContain("skill-31: Skill 31");
    expect(instructions).not.toContain("skill-32: Skill 32");
    expect(instructions).toContain("Use search_skills to find every other Skill by domain.");
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
      failureClass: "rate_limit",
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

  it("accepts a late provider result after idle timeout instead of aborting the child", async () => {
    vi.useFakeTimers();
    try {
      let providerSignal: AbortSignal | undefined;
      let resolveLate: ((value: unknown) => void) | undefined;
      const progress: DelegateProgress[] = [];
      generateTextMock.mockImplementationOnce((options: Record<string, unknown>) => {
        providerSignal = options["abortSignal"] as AbortSignal;
        return new Promise((resolve) => {
          resolveLate = resolve;
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
        goal: "Accept the late result if it still arrives",
        index: 0,
        readOnly: true,
        allowDelegation: false,
        onProgress: (update) => progress.push(update),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(providerSignal?.aborted).toBe(false);
      expect(generateTextMock).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      expect(progress.some((update) => typeof update !== "string" && update.status === "recovering")).toBe(true);

      resolveLate?.({
        text: "Late evidence still counts",
        steps: [{ text: "Late evidence still counts" }],
        toolCalls: [],
        usage: {},
      });
      await vi.runAllTicks();
      await expect(pending).resolves.toMatchObject({
        summary: "Late evidence still counts",
      });
      expect(release).toHaveBeenCalledWith(handle, {
        providerId: "worker-provider",
        accountId: "timeout",
        modelId: "slow-worker",
        outcome: "success",
        phase: "stream",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves terminal provider failures without launching a second attempt", async () => {
    const providerError = Object.assign(new Error("provider overloaded"), { statusCode: 503 });
    generateTextMock.mockRejectedValueOnce(providerError);
    const handle = { lease: "worker-server-503" };
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

    await expect(runner({
      childId: "child-server-503",
      goal: "Propagate the provider error",
      index: 0,
      readOnly: true,
      allowDelegation: false,
      onProgress: () => undefined,
    })).rejects.toBe(providerError);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(handle, {
      providerId: "worker-provider",
      accountId: "timeout",
      modelId: "slow-worker",
      outcome: "retryable-error",
      phase: "stream",
      statusCode: 503,
      failureClass: "server",
    });
  });

  it("renews the child idle lease on observed progress so long-running research can finish", async () => {
    vi.useFakeTimers();
    try {
      let providerSignal: AbortSignal | undefined;
      generateTextMock.mockImplementationOnce((options: Record<string, unknown>) => {
        providerSignal = options["abortSignal"] as AbortSignal;
        const onToolExecutionStart = options["onToolExecutionStart"] as (event: unknown) => void;
        const onStepEnd = options["onStepEnd"] as (event: unknown) => void;
        return new Promise((resolve) => {
          setTimeout(() => {
            onToolExecutionStart({ toolCall: { toolName: "read_file", input: { path: "src\\renewed.ts" } } });
          }, 800);
          setTimeout(() => {
            onStepEnd({ stepNumber: 0, usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } });
          }, 1_600);
          setTimeout(() => {
            resolve({
              text: "Long-running evidence completed",
              steps: [{ text: "Long-running evidence completed" }],
              toolCalls: [{ toolName: "read_file" }],
              usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
            });
          }, 2_400);
        });
      });
      const runner = createReadOnlyChildRunner({
        model: { id: "slow-worker" } as unknown as LanguageModel,
        modelId: "slow-worker",
        tools: definitions("read_file"),
        maxSteps: 2,
        maxRetries: 0,
        timeoutMs: 1_000,
        cost: { inputPerM: 0, outputPerM: 0 },
      });

      const pending = runner({
        childId: "child-renewed-timeout",
        goal: "Keep going while progress is real",
        index: 0,
        readOnly: true,
        allowDelegation: false,
        onProgress: () => undefined,
      });

      await vi.advanceTimersByTimeAsync(900);
      expect(providerSignal?.aborted).not.toBe(true);
      await vi.advanceTimersByTimeAsync(900);
      expect(providerSignal?.aborted).not.toBe(true);
      await vi.advanceTimersByTimeAsync(900);
      await expect(pending).resolves.toMatchObject({
        summary: "Long-running evidence completed",
        filesRead: ["src/renewed.ts"],
      });
      expect(providerSignal?.aborted).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps evidence-bearing research alive instead of returning a timeout partial", async () => {
    vi.useFakeTimers();
    try {
      let providerSignal: AbortSignal | undefined;
      let resolveLate: ((value: unknown) => void) | undefined;
      const progress: DelegateProgress[] = [];
      generateTextMock.mockImplementationOnce((options: Record<string, unknown>) => {
        providerSignal = options["abortSignal"] as AbortSignal;
        const onToolExecutionStart = options["onToolExecutionStart"] as (event: unknown) => void;
        onToolExecutionStart({ toolCall: { toolName: "read_file", input: { path: "src\\partial.ts" } } });
        return new Promise((resolve) => {
          resolveLate = resolve;
        });
      });
      const handle = { lease: "worker-partial-timeout" };
      const acquire = vi.fn(() => handle);
      const release = vi.fn();
      const runner = createReadOnlyChildRunner({
        model: { id: "slow-worker" } as unknown as LanguageModel,
        modelId: "slow-worker",
        tools: definitions("read_file"),
        maxSteps: 2,
        maxRetries: 0,
        timeoutMs: 1_000,
        cost: { inputPerM: 0, outputPerM: 0 },
        providerAttempt: {
          lifecycle: { acquire, release },
          target: { providerId: "worker-provider", accountId: "partial", modelId: "slow-worker" },
        },
      });

      const pending = runner({
        childId: "child-partial-timeout",
        goal: "Return whatever evidence exists",
        index: 0,
        readOnly: true,
        allowDelegation: false,
        onProgress: (update) => progress.push(update),
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(progress.some((update) => typeof update !== "string" && update.status === "recovering")).toBe(true);
      expect(providerSignal?.aborted).toBe(false);
      expect(release).not.toHaveBeenCalled();

      resolveLate?.({
        text: "Recovered after reading the file",
        steps: [{ text: "Recovered after reading the file" }],
        toolCalls: [{ toolName: "read_file" }],
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      });
      await expect(pending).resolves.toMatchObject({
        filesRead: ["src/partial.ts"],
        summary: "Recovered after reading the file",
      });
      expect(release).toHaveBeenCalledWith(handle, {
        providerId: "worker-provider",
        accountId: "partial",
        modelId: "slow-worker",
        outcome: "success",
        phase: "stream",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns to running progress after a recovering warning when activity resumes", async () => {
    vi.useFakeTimers();
    try {
      let providerSignal: AbortSignal | undefined;
      const progress: DelegateProgress[] = [];
      generateTextMock.mockImplementationOnce((options: Record<string, unknown>) => {
        providerSignal = options["abortSignal"] as AbortSignal;
        const onToolExecutionStart = options["onToolExecutionStart"] as (event: unknown) => void;
        const onStepEnd = options["onStepEnd"] as (event: unknown) => void;
        return new Promise((resolve) => {
          setTimeout(() => {
            onToolExecutionStart({
              toolCall: { toolName: "read_file", input: { path: "src/a.ts" } },
            });
          }, 900);
          setTimeout(() => {
            onStepEnd({ stepNumber: 0, usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } });
          }, 2_100);
          setTimeout(() => {
            resolve({
              text: "Recovered and finished",
              steps: [{ text: "Recovered and finished" }],
              toolCalls: [{ toolName: "read_file" }],
              usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
            });
          }, 2_200);
        });
      });
      const runner = createReadOnlyChildRunner({
        model: { id: "slow-worker" } as unknown as LanguageModel,
        modelId: "slow-worker",
        tools: definitions("read_file"),
        maxSteps: 2,
        maxRetries: 0,
        timeoutMs: 1_000,
        cost: { inputPerM: 0, outputPerM: 0 },
      });

      const pending = runner({
        childId: "child-progress-refresh",
        goal: "Keep working",
        index: 0,
        readOnly: true,
        allowDelegation: false,
        onProgress: (update) => progress.push(update),
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(providerSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(progress.some((update) => typeof update !== "string" && update.status === "recovering")).toBe(true);
      expect(providerSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toMatchObject({
        filesRead: ["src/a.ts"],
        summary: "Recovered and finished",
      });
      expect(progress.some((update) => typeof update !== "string" && update.status === "running" && update.text.includes("Research step 1 complete"))).toBe(true);
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
      failureClass: "unknown",
    });
  });
});
