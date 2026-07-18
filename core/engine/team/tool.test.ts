import { describe, expect, it, vi } from "vitest";
import type { RuntimeTeamRole, RuntimeTeamSpec } from "../types.js";
import { buildTeamDelegateTool } from "./tool.js";

vi.mock("ai", () => ({ tool: (definition: unknown) => definition }));

function role(id: string): RuntimeTeamRole {
  return {
    id,
    name: id,
    target: {
      providerId: `provider-${id}`,
      protocol: "openai-chat",
      baseURL: `https://${id}.example/v1`,
      model: `model-${id}`,
      apiKey: "private",
    },
    skillIds: [],
    capabilities: ["workspace.read"],
    canSpawn: false,
    maxChildren: 0,
  };
}

function spec(roles: RuntimeTeamRole[], patch: Partial<RuntimeTeamSpec["limits"]> = {}): RuntimeTeamSpec {
  return {
    profileId: "review-team",
    name: "Review team",
    workflow: "supervisor",
    roles,
    limits: {
      maxParallel: 2,
      maxDepth: 2,
      maxAgents: 6,
      maxTasks: 6,
      maxStepsPerAgent: 4,
      timeoutMs: 5_000,
      ...patch,
    },
  };
}

const artifact = (taskId: string) => ({
  taskId,
  summary: `summary ${taskId}`,
  provenance: [],
  confidence: 0.8,
  evidence: [`file:${taskId}`],
  validation: [],
  uncertainties: [],
  whatWasNotChecked: [],
});

describe("buildTeamDelegateTool", () => {
  it("routes provider-specific roles through a dependency graph and emits tree provenance", async () => {
    const researcher = role("researcher");
    const critic = role("critic");
    const calls: Array<{ id: string; dependencies: string[] }> = [];
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const tools = buildTeamDelegateTool({
      spec: spec([researcher, critic]),
      emit: (event) => events.push(event as never),
      executors: [researcher, critic].map((member) => ({
        role: member,
        run: async (context) => {
          calls.push({ id: context.task.id, dependencies: [...context.dependencyArtifacts.keys()] });
          return artifact(context.task.id);
        },
      })),
    });
    const team = tools.team_delegate as unknown as {
      execute: (input: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => Promise<string>;
    };

    const output = JSON.parse(await team.execute({
      tasks: [
        { id: "facts", goal: "Find facts", memberId: "researcher" },
        { id: "review", goal: "Review facts", memberId: "critic", dependsOn: ["facts"] },
      ],
    }, { toolCallId: "call-1" }));
    const runId = events.find((event) => event.type === "team.start")?.payload.run_id;

    expect(calls).toEqual([
      { id: "facts", dependencies: [] },
      { id: "review", dependencies: ["facts"] },
    ]);
    expect(output.tasks[1]).toMatchObject({ id: "review", status: "succeeded" });
    expect(output.tasks[1].provenance).toEqual(expect.arrayContaining([
      "engine:role:critic",
      "engine:provider:provider-critic",
      "engine:model:model-critic",
    ]));
    expect(events.find((event) => event.type === "subagent.start" && event.payload.task_id === "review")?.payload).toMatchObject({
      depth: 0,
      parent_id: null,
      role_id: "critic",
      provider_id: "provider-critic",
      run_id: runId,
    });
    expect(events.at(-1)).toMatchObject({
      type: "team.complete",
      payload: { status: "completed", completed_tasks: 2, failed_tasks: 0 },
    });
  });

  it("fans a consensus question out to every configured provider role", async () => {
    const researcher = role("researcher");
    const critic = role("critic");
    const calls: string[] = [];
    const tools = buildTeamDelegateTool({
      spec: { ...spec([researcher, critic]), workflow: "consensus" },
      emit: () => undefined,
      executors: [researcher, critic].map((member) => ({
        role: member,
        run: async (context) => {
          calls.push(`${context.task.memberId}:${context.task.goal}`);
          return artifact(context.task.id);
        },
      })),
    });
    const team = tools.team_delegate as unknown as {
      execute: (input: unknown, options: { toolCallId: string }) => Promise<string>;
    };

    const output = JSON.parse(await team.execute({
      tasks: [{ id: "question", goal: "Which claim is best supported?" }],
    }, { toolCallId: "consensus" }));

    expect(calls.sort()).toEqual([
      "critic:Which claim is best supported?",
      "researcher:Which claim is best supported?",
    ]);
    expect(output.workflow).toBe("consensus");
    expect(output.tasks).toHaveLength(2);
    await expect(team.execute({
      tasks: [{ id: "bad", goal: "Bad", memberId: "critic" }],
    }, { toolCallId: "invalid-consensus" })).rejects.toThrow("consensus_task_shape_invalid");
  });

  it("rejects unknown roles before starting a model call", async () => {
    const researcher = role("researcher");
    const run = vi.fn();
    const tools = buildTeamDelegateTool({
      spec: spec([researcher]),
      emit: () => undefined,
      executors: [{ role: researcher, run }],
    });
    const team = tools.team_delegate as unknown as { execute: (input: unknown, options: { toolCallId: string }) => Promise<string> };
    await expect(team.execute({ tasks: [{ id: "x", goal: "x", memberId: "missing" }] }, { toolCallId: "call" }))
      .rejects.toThrow("team_role_unavailable:missing");
    expect(run).not.toHaveBeenCalled();
  });

  it("always closes a started run when graph validation fails", async () => {
    const researcher = role("researcher");
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const tools = buildTeamDelegateTool({
      spec: spec([researcher]),
      emit: (event) => events.push(event as never),
      executors: [{ role: researcher, run: async (context) => artifact(context.task.id) }],
    });
    const team = tools.team_delegate as unknown as {
      execute: (input: unknown, options: { toolCallId: string }) => Promise<string>;
    };

    await expect(team.execute({
      tasks: [
        { id: "a", goal: "a", dependsOn: ["b"] },
        { id: "b", goal: "b", dependsOn: ["a"] },
      ],
    }, { toolCallId: "cycle" })).rejects.toThrow();

    expect(events.map((event) => event.type)).toEqual(["team.start", "team.complete"]);
    expect(events.at(-1)?.payload).toMatchObject({
      run_id: events[0]?.payload.run_id,
      status: "failed",
      completed_tasks: 0,
      failed_tasks: 2,
    });
  });

  it("emits a recovery progress update and lets a slow role finish", async () => {
    vi.useFakeTimers();
    try {
      const researcher = role("researcher");
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const tools = buildTeamDelegateTool({
        spec: spec([researcher], { timeoutMs: 10_000, idleTimeoutMs: 1_000 }),
        emit: (event) => events.push(event as never),
        executors: [{
          role: researcher,
          run: async (context) => {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            return artifact(context.task.id);
          },
        }],
      });
      const team = tools.team_delegate as unknown as {
        execute: (input: unknown, options: { toolCallId: string }) => Promise<string>;
      };

      const pending = team.execute({ tasks: [{ id: "slow", goal: "Slow" }] }, { toolCallId: "slow" });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(events.find((event) => event.type === "subagent.progress" && String(event.payload.text).includes("still running"))?.payload)
        .toMatchObject({ task_id: "slow", status: "recovering" });
      await vi.advanceTimersByTimeAsync(500);
      const output = JSON.parse(await pending);
      expect(output.tasks[0]).toMatchObject({ id: "slow", status: "succeeded", summary: "summary slow" });
      expect(events.find((event) => event.type === "subagent.failed")).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: "team.complete", payload: { status: "completed", completed_tasks: 1, failed_tasks: 0 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a queued task healthy while another task exceeds the idle threshold", async () => {
    vi.useFakeTimers();
    try {
      const researcher = role("researcher");
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const tools = buildTeamDelegateTool({
        spec: spec([researcher], { timeoutMs: 1_000, maxParallel: 1 }),
        emit: (event) => events.push(event as never),
        executors: [{
          role: researcher,
          run: async (context) => {
            if (context.task.id === "slow") {
              await new Promise((resolve) => setTimeout(resolve, 1_500));
              return artifact(context.task.id);
            }
            return artifact(context.task.id);
          },
        }],
      });
      const team = tools.team_delegate as unknown as {
        execute: (input: unknown, options: { toolCallId: string }) => Promise<string>;
      };

      const pending = team.execute({ tasks: [
        { id: "slow", goal: "Slow" },
        { id: "fast", goal: "Fast" },
      ] }, { toolCallId: "mixed" });
      await vi.advanceTimersByTimeAsync(1_600);
      const output = JSON.parse(await pending);

      expect(output.tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "slow", status: "succeeded" }),
        expect.objectContaining({ id: "fast", status: "succeeded" }),
      ]));
      expect(events.find((event) => event.type === "subagent.progress" && String(event.payload.text).includes("still running"))?.payload.task_id)
        .toBe("slow");
      expect(events.filter((event) => event.type === "subagent.complete").map((event) => event.payload.task_id)).toContain("fast");
      expect(events.at(-1)).toMatchObject({ type: "team.complete", payload: { status: "completed", completed_tasks: 2, failed_tasks: 0 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors idle thresholds above five minutes without clamping them down", async () => {
    vi.useFakeTimers();
    try {
      const researcher = role("researcher");
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
      const tools = buildTeamDelegateTool({
        spec: spec([researcher], { timeoutMs: 400_000 }),
        emit: (event) => events.push(event as never),
        executors: [{
          role: researcher,
          run: async (context) => {
            await new Promise((resolve) => setTimeout(resolve, 450_000));
            return artifact(context.task.id);
          },
        }],
      });
      const team = tools.team_delegate as unknown as {
        execute: (input: unknown, options: { toolCallId: string }) => Promise<string>;
      };

      const pending = team.execute({ tasks: [{ id: "slow", goal: "Slow" }] }, { toolCallId: "long-idle" });
      await vi.advanceTimersByTimeAsync(350_000);
      expect(events.some((event) => event.type === "subagent.progress" && String(event.payload.text).includes("400000ms"))).toBe(false);
      await vi.advanceTimersByTimeAsync(100_000);
      expect(events.find((event) => event.type === "subagent.progress" && String(event.payload.text).includes("400000ms"))?.payload.task_id)
        .toBe("slow");
      await vi.advanceTimersByTimeAsync(1);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares the parallel limit across simultaneous team tool calls", async () => {
    const researcher = role("researcher");
    let active = 0;
    let peak = 0;
    const tools = buildTeamDelegateTool({
      spec: spec([researcher], { maxParallel: 2, maxAgents: 4, maxTasks: 4 }),
      emit: () => undefined,
      executors: [{
        role: researcher,
        run: async (context) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return artifact(context.task.id);
        },
      }],
    });
    const team = tools.team_delegate as unknown as {
      execute: (input: unknown, options: { toolCallId: string }) => Promise<string>;
    };

    await Promise.all([
      team.execute({ tasks: [
        { id: "a1", goal: "a1" },
        { id: "a2", goal: "a2" },
      ] }, { toolCallId: "call-a" }),
      team.execute({ tasks: [
        { id: "b1", goal: "b1" },
        { id: "b2", goal: "b2" },
      ] }, { toolCallId: "call-b" }),
    ]);

    expect(peak).toBe(2);
  });

  it("carries validated source receipts through model results and completion events", async () => {
    const researcher = role("researcher");
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const receipt = {
      id: "source-7c4d0d",
      requestedUrl: "https://example.test/research",
      finalUrl: "https://docs.example.test/final-guide",
      title: "Official guide",
      contentDigest: "a".repeat(64),
      fetchedAt: "2026-07-14T00:00:00.000Z",
    };
    const tools = buildTeamDelegateTool({
      spec: spec([researcher]),
      emit: (event) => events.push(event as never),
      executors: [{
        role: researcher,
        run: async (context) => ({
          ...artifact(context.task.id),
          sources: [
            receipt,
            {
              ...receipt,
              id: "malformed-digest",
              contentDigest: "not-a-sha256",
            },
            {
              ...receipt,
              id: "malformed-url",
              finalUrl: "javascript:alert(1)",
            },
            {
              ...receipt,
              id: "non-http-url",
              finalUrl: "ftp://docs.example.test/final-guide",
            },
            {
              ...receipt,
              id: "credentialed-url",
              finalUrl: "https://user:secret@docs.example.test/final-guide",
            },
            {
              ...receipt,
              id: "private-ip-url",
              finalUrl: "http://127.0.0.1/private-guide",
            },
          ],
        }),
      }],
    });
    const team = tools.team_delegate as unknown as {
      execute: (input: unknown, options: { toolCallId: string }) => Promise<string>;
    };

    const output = JSON.parse(await team.execute({
      tasks: [{ id: "research", goal: "Verify source" }],
    }, { toolCallId: "receipt" }));

    expect(output.tasks[0].sources).toEqual([{
      id: receipt.id,
      finalUrl: receipt.finalUrl,
      title: receipt.title,
      contentDigest: receipt.contentDigest,
      fetchedAt: receipt.fetchedAt,
    }]);
    const completed = events.find((event) => event.type === "subagent.complete");
    expect(completed?.payload.sources).toEqual([{
      id: receipt.id,
      requested_url: receipt.requestedUrl,
      final_url: receipt.finalUrl,
      title: receipt.title,
      content_digest: receipt.contentDigest,
      fetched_at: receipt.fetchedAt,
    }]);
  });

  it("returns valid bounded JSON while keeping full evidence on ledger events", async () => {
    const researcher = role("researcher");
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const tools = buildTeamDelegateTool({
      spec: spec([researcher]),
      maxResultChars: 500,
      emit: (event) => events.push(event as never),
      executors: [{
        role: researcher,
        run: async (context) => ({
          ...artifact(context.task.id),
          summary: `summary ${context.task.id} ${"x".repeat(3_000)}`,
          evidence: ["observed:file:src/main.ts", `sk-${"A".repeat(24)}`],
          validation: ["unit tests"],
          whatWasNotChecked: ["live deployment"],
        }),
      }],
    });
    const team = tools.team_delegate as unknown as {
      execute: (input: unknown, options: { toolCallId: string }) => Promise<string>;
    };
    const output = await team.execute({
      tasks: Array.from({ length: 6 }, (_, index) => ({ id: `task-${index}`, goal: `Task ${index}` })),
    }, { toolCallId: "bounded" });

    expect(output.length).toBeLessThanOrEqual(500);
    expect(() => JSON.parse(output)).not.toThrow();
    expect(JSON.parse(output).omittedTaskCount).toBeGreaterThan(0);
    const completed = events.find((event) => event.type === "subagent.complete");
    expect(completed?.payload).toMatchObject({
      evidence: ["observed:file:src/main.ts", "reported:[REDACTED]"],
      files_read: ["src/main.ts"],
      validation: ["unit tests"],
      what_was_not_checked: ["live deployment"],
    });
  });
});
