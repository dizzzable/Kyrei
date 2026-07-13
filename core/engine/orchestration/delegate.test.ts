import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import {
  buildDelegateTool,
  delegateChildId,
  type DelegateEvent,
  type DelegateTaskRequest,
} from "./delegate.js";

interface DelegateDefinition {
  execute: (
    input: { tasks: Array<{ goal: string }> },
    options: { toolCallId: string; messages: never[]; abortSignal?: AbortSignal },
  ) => Promise<unknown>;
  inputSchema: {
    safeParse: (input: unknown) => { success: boolean };
  };
}

function definition(tools: ToolSet): DelegateDefinition {
  return tools["delegate_read"] as unknown as DelegateDefinition;
}

async function execute(
  tools: ToolSet,
  tasks: Array<{ goal: string }>,
  options: { toolCallId?: string; abortSignal?: AbortSignal } = {},
): Promise<string> {
  const value = await definition(tools).execute(
    { tasks },
    {
      toolCallId: options.toolCallId ?? "delegate-test",
      messages: [],
      abortSignal: options.abortSignal,
    },
  );
  return String(value);
}

function createGate(): { promise: Promise<void>; open: () => void } {
  let open = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

describe("delegate_read tool", () => {
  it("is absent when delegation is disabled", () => {
    const tools = buildDelegateTool({
      enabled: false,
      maxTasks: 3,
      maxParallel: 2,
      emit: vi.fn(),
      runTask: vi.fn(),
    });

    expect(tools).toEqual({});
  });

  it("validates the configured task count", async () => {
    const tools = buildDelegateTool({
      enabled: true,
      maxTasks: 2,
      maxParallel: 2,
      emit: vi.fn(),
      runTask: async () => ({ summary: "unused" }),
    });
    const schema = definition(tools).inputSchema;

    expect(schema.safeParse({ tasks: [] }).success).toBe(false);
    expect(schema.safeParse({ tasks: [{ goal: "a" }, { goal: "b" }] }).success).toBe(true);
    expect(schema.safeParse({ tasks: [{ goal: "a" }, { goal: "b" }, { goal: "c" }] }).success).toBe(false);
    await expect(execute(tools, [])).rejects.toThrow();
  });

  it("bounds concurrency, keeps output order, and derives stable child ids", async () => {
    const gate = createGate();
    const events: DelegateEvent[] = [];
    const requests: DelegateTaskRequest[] = [];
    let active = 0;
    let maximumActive = 0;

    const tools = buildDelegateTool({
      enabled: true,
      maxTasks: 4,
      maxParallel: 2,
      emit: (event) => events.push(event),
      runTask: async (request) => {
        requests.push(request);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (request.index === 0) await gate.promise;
          return { summary: `summary-${request.goal}` };
        } finally {
          active -= 1;
        }
      },
    });

    const pending = execute(
      tools,
      [{ goal: "first" }, { goal: "second" }, { goal: "third" }, { goal: "fourth" }],
      { toolCallId: "call-42" },
    );

    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect(maximumActive).toBe(2);
    gate.open();

    await expect(pending).resolves.toBe(
      "[1] summary-first\n[2] summary-second\n[3] summary-third\n[4] summary-fourth",
    );
    expect(requests.map((request) => request.childId)).toEqual([
      delegateChildId("call-42", 0),
      delegateChildId("call-42", 1),
      delegateChildId("call-42", 2),
      delegateChildId("call-42", 3),
    ]);
    expect(requests.every((request) => request.readOnly && !request.allowDelegation)).toBe(true);

    const starts = events.filter((event) => event.type === "subagent.start");
    const completes = events.filter((event) => event.type === "subagent.complete");
    expect(starts).toHaveLength(4);
    expect(completes).toHaveLength(4);
    expect(starts[0]?.payload).toMatchObject({
      subagent_id: "delegate-tool:call-42:0",
      parent_id: null,
      parent_tool_call_id: "call-42",
      task_count: 4,
      task_index: 0,
      goal: "first",
      status: "running",
    });
  });

  it("shares the parallel cap across simultaneous delegate_read calls", async () => {
    const gate = createGate();
    const requests: DelegateTaskRequest[] = [];
    let active = 0;
    let maximumActive = 0;
    const tools = buildDelegateTool({
      enabled: true,
      maxTasks: 2,
      maxParallel: 2,
      emit: vi.fn(),
      runTask: async (request) => {
        requests.push(request);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await gate.promise;
          return { summary: request.goal };
        } finally {
          active -= 1;
        }
      },
    });

    const first = execute(tools, [{ goal: "a" }, { goal: "b" }], { toolCallId: "call-a" });
    const second = execute(tools, [{ goal: "c" }, { goal: "d" }], { toolCallId: "call-b" });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(maximumActive).toBe(2);
    gate.open();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "[1] a\n[2] b",
      "[1] c\n[2] d",
    ]);
    expect(maximumActive).toBe(2);
    expect(requests).toHaveLength(4);
  });

  it("relays progress and terminal usage, tool, and file metadata", async () => {
    const events: DelegateEvent[] = [];
    const onTaskStarted = vi.fn();
    const onTaskProgress = vi.fn();
    const onTaskCompleted = vi.fn();
    const tools = buildDelegateTool({
      enabled: true,
      maxTasks: 1,
      maxParallel: 1,
      emit: (event) => events.push(event),
      onTaskStarted,
      onTaskProgress,
      onTaskCompleted,
      runTask: async ({ onProgress }) => {
        onProgress({
          text: "Reading src/a.ts",
          model: "small-model",
          usage: { inputTokens: 10 },
          toolCount: 1,
          providerCalls: 1,
          filesRead: ["src/a.ts"],
        });
        return {
          summary: "Found the call site.",
          model: "small-model",
          usage: { outputTokens: 5, totalTokens: 15, costUsd: 0.01 },
          toolCount: 2,
          providerCalls: 2,
          filesRead: ["src/b.ts"],
        };
      },
    });

    await execute(tools, [{ goal: "Find the call site" }]);

    expect(events.find((event) => event.type === "subagent.progress")?.payload).toMatchObject({
      text: "Reading src/a.ts",
      model: "small-model",
      input_tokens: 10,
      tool_count: 1,
      provider_calls: 1,
      files_read: ["src/a.ts"],
    });
    expect(events.find((event) => event.type === "subagent.complete")?.payload).toMatchObject({
      status: "completed",
      summary: "Found the call site.",
      model: "small-model",
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cost_usd: 0.01,
      tool_count: 2,
      provider_calls: 2,
      files_read: ["src/a.ts", "src/b.ts"],
    });
    expect(onTaskStarted).toHaveBeenCalledWith(expect.objectContaining({ index: 0 }));
    expect(onTaskProgress).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0 }),
      expect.objectContaining({ providerCalls: 1, usage: { inputTokens: 10 } }),
    );
    expect(onTaskCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0 }),
      expect.objectContaining({
        providerCalls: 2,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.01 },
      }),
    );
  });

  it("contains one child failure without rejecting successful siblings", async () => {
    const events: DelegateEvent[] = [];
    const visited: string[] = [];
    const tools = buildDelegateTool({
      enabled: true,
      maxTasks: 3,
      maxParallel: 1,
      emit: (event) => events.push(event),
      runTask: async ({ goal }) => {
        visited.push(goal);
        if (goal === "bad") throw new Error("child exploded");
        return { summary: `ok-${goal}` };
      },
    });

    await expect(execute(tools, [{ goal: "a" }, { goal: "bad" }, { goal: "c" }])).resolves.toBe(
      "[1] ok-a\n[2] Failed: child exploded\n[3] ok-c",
    );
    expect(visited).toEqual(["a", "bad", "c"]);
    expect(events.filter((event) => event.type === "subagent.complete")).toHaveLength(2);
    expect(events.find((event) => event.type === "subagent.failed")?.payload).toMatchObject({
      status: "failed",
      task_index: 1,
      error: "child exploded",
      summary: "Failed: child exploded",
    });
  });

  it("redacts secrets from child summaries, errors, and emitted events", async () => {
    const secret = `sk-${"A".repeat(24)}`;
    const events: DelegateEvent[] = [];
    const tools = buildDelegateTool({
      enabled: true,
      maxTasks: 2,
      maxParallel: 1,
      emit: (event) => events.push(event),
      runTask: async ({ index }) => {
        if (index === 1) throw new Error(`failed with ${secret}`);
        return { summary: `found ${secret}` };
      },
    });

    const output = await execute(tools, [{ goal: "one" }, { goal: "two" }]);
    expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("interrupts active children and starts no queued work after parent abort", async () => {
    const controller = new AbortController();
    const events: DelegateEvent[] = [];
    const requests: DelegateTaskRequest[] = [];
    const tools = buildDelegateTool({
      enabled: true,
      maxTasks: 3,
      maxParallel: 2,
      abortSignal: controller.signal,
      emit: (event) => events.push(event),
      runTask: async (request) => {
        requests.push(request);
        await new Promise<void>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        });
        return { summary: "unreachable" };
      },
    });

    const pending = execute(tools, [{ goal: "one" }, { goal: "two" }, { goal: "queued" }]);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    controller.abort(new Error("parent stopped"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "parent stopped" });
    await vi.waitFor(() => expect(events.filter((event) => event.type === "subagent.failed")).toHaveLength(2));
    expect(requests).toHaveLength(2);
    expect(events.filter((event) => event.type === "subagent.failed").map((event) => event.payload.status)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(events.some((event) => event.payload.task_index === 2)).toBe(false);
  });
});
