import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTeamRole, RuntimeTeamSpec } from "../types.js";
import type { TeamArtifact } from "./types.js";

const createTeamRoleExecutorsMock = vi.fn();

vi.mock("./runtime.js", () => ({
  createTeamRoleExecutors: createTeamRoleExecutorsMock,
}));

const role = (id: string): RuntimeTeamRole => ({
  id,
  name: id,
  target: {
    providerId: "local",
    protocol: "openai-chat",
    baseURL: "http://127.0.0.1:11434/v1",
    model: "test-model",
    apiKey: "",
    requiresApiKey: false,
  },
  skillIds: [],
  capabilities: ["workspace.read", "workspace.write", "terminal"],
  canSpawn: false,
  maxChildren: 0,
});

const team: RuntimeTeamSpec = {
  profileId: "research",
  name: "Research",
  workflow: "supervisor",
  limits: {
    maxParallel: 2,
    maxDepth: 1,
    maxAgents: 3,
    maxTasks: 3,
    maxStepsPerAgent: 4,
    timeoutMs: 5_000,
  },
  roles: [role("researcher"), role("reviewer")],
};

function artifact(taskId: string): TeamArtifact {
  return {
    taskId,
    summary: `${taskId} structured result`,
    provenance: ["test"],
    confidence: 0.8,
    evidence: ["reported:test evidence"],
    validation: ["reviewed"],
    uncertainties: ["No deterministic verifier ran."],
    whatWasNotChecked: ["No writes were attempted."],
  };
}

describe("runTeamDepartment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clamps the Team runtime to read-only and synthesizes every role artifact", async () => {
    const providerAttemptLifecycle = { acquire: vi.fn(() => ({})), release: vi.fn() };
    const runs: Array<{ taskId: string; dependencies: string[] }> = [];
    createTeamRoleExecutorsMock.mockResolvedValue(team.roles.map((member) => ({
      role: member,
      run: async (
        context: { task: { id: string }; dependencyArtifacts: ReadonlyMap<string, TeamArtifact> },
        runtime: { onMetrics?: (metrics: TeamArtifact["metrics"]) => void },
      ) => {
        runs.push({ taskId: context.task.id, dependencies: [...context.dependencyArtifacts.keys()] });
        const metrics = {
          inputTokens: 3,
          outputTokens: 1,
          totalTokens: 4,
          costUsd: 0.01,
          toolCount: 1,
          providerCalls: 2,
          unmeteredProviderCalls: 1,
        };
        runtime.onMetrics?.(metrics);
        return { ...artifact(context.task.id), metrics };
      },
    })));
    const { runTeamDepartment } = await import("./department.js");

    const result = await runTeamDepartment({
      team,
      goal: "Research a safe implementation",
      stageId: "research",
      providerAttemptLifecycle,
    });

    expect(createTeamRoleExecutorsMock).toHaveBeenCalledWith(expect.objectContaining({
      spec: team,
      readOnly: true,
      providerAttemptLifecycle,
    }));
    expect(result.artifact).toMatchObject({ taskId: "synthesis", summary: "synthesis structured result" });
    expect(result.metrics).toMatchObject({
      inputTokens: 9,
      outputTokens: 3,
      totalTokens: 12,
      costUsd: 0.03,
      toolCount: 3,
      providerCalls: 6,
      unmeteredProviderCalls: 3,
    });
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "role-1-researcher", dependencies: [] }),
      expect.objectContaining({ taskId: "role-2-reviewer", dependencies: [] }),
      expect.objectContaining({ taskId: "synthesis", dependencies: ["role-1-researcher", "role-2-reviewer"] }),
    ]));
  });

  it("does not start queued roles when the department signal is already aborted", async () => {
    const runner = vi.fn(async (context: { task: { id: string } }) => artifact(context.task.id));
    createTeamRoleExecutorsMock.mockResolvedValue(team.roles.map((member) => ({ role: member, run: runner })));
    const { runTeamDepartment } = await import("./department.js");
    const controller = new AbortController();
    controller.abort(new Error("operator paused"));

    await expect(runTeamDepartment({
      team,
      goal: "Do not start",
      stageId: "research",
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("redacts the frozen sensitive-value snapshot before returning or emitting a Team artifact", async () => {
    const secret = "arbitrary-team-secret-value";
    const singleRoleTeam: RuntimeTeamSpec = {
      ...team,
      roles: [team.roles[0]!],
      limits: { ...team.limits, maxAgents: 1, maxTasks: 1 },
    };
    createTeamRoleExecutorsMock.mockResolvedValue([{
      role: singleRoleTeam.roles[0]!,
      run: async (context: { task: { id: string } }) => ({
        ...artifact(context.task.id),
        summary: `Result contains ${secret}`,
        evidence: [`Observed ${secret}`],
      }),
    }]);
    const { runTeamDepartment } = await import("./department.js");
    const events: unknown[] = [];

    const result = await runTeamDepartment({
      team: singleRoleTeam,
      goal: "Redact the Team output",
      stageId: "research",
      sensitiveValues: [secret],
      emit: (event) => events.push(event),
    });

    expect(JSON.stringify({ result, events })).not.toContain(secret);
    expect(result.artifact.summary).toContain("[REDACTED]");
  });

  it("rejects a failed department with bounded usage attached to the error", async () => {
    const singleRoleTeam: RuntimeTeamSpec = {
      ...team,
      roles: [team.roles[0]!],
      limits: { ...team.limits, maxAgents: 1, maxTasks: 1 },
    };
    createTeamRoleExecutorsMock.mockResolvedValue([{
      role: singleRoleTeam.roles[0]!,
      run: async (
        _context: unknown,
        runtime: { onMetrics?: (metrics: TeamArtifact["metrics"]) => void },
      ) => {
        runtime.onMetrics?.({
          inputTokens: 5,
          outputTokens: 2,
          totalTokens: 7,
          providerCalls: 2,
          unmeteredProviderCalls: 1,
        });
        throw new Error("provider failed after one step");
      },
    }]);
    const { runTeamDepartment, TeamDepartmentRunError } = await import("./department.js");

    let failure: unknown;
    try {
      await runTeamDepartment({
        team: singleRoleTeam,
        goal: "Preserve failed usage",
        stageId: "research",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TeamDepartmentRunError);
    expect(failure).toMatchObject({
      message: "team_department_synthesis_failed",
      metrics: {
        inputTokens: 5,
        outputTokens: 2,
        totalTokens: 7,
        providerCalls: 2,
        unmeteredProviderCalls: 1,
      },
    });
  });

  it("emits recovery progress and eventually completes a slow department role", async () => {
    vi.useFakeTimers();
    try {
      const singleRoleTeam: RuntimeTeamSpec = {
        ...team,
        roles: [team.roles[0]!],
        limits: { ...team.limits, maxAgents: 1, maxTasks: 1, timeoutMs: 10_000, idleTimeoutMs: 1_000 },
      };
      createTeamRoleExecutorsMock.mockResolvedValue([{
        role: singleRoleTeam.roles[0]!,
        run: async (context: { task: { id: string } }) => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          return artifact(context.task.id);
        },
      }]);
      const { runTeamDepartment } = await import("./department.js");
      const events: Array<{ type: string; payload: Record<string, unknown> }> = [];

      const pending = runTeamDepartment({
        team: singleRoleTeam,
        goal: "Wait for the slow role",
        stageId: "research",
        emit: (event) => events.push(event as never),
      });

      await vi.advanceTimersByTimeAsync(1_100);
      expect(events.find((event) => event.type === "subagent.progress" && String(event.payload.text).includes("still running"))?.payload)
        .toMatchObject({ task_id: "role-1-researcher", status: "recovering" });
      await vi.advanceTimersByTimeAsync(500);
      const result = await pending;

      expect(result.artifact).toMatchObject({ taskId: "role-1-researcher", summary: "role-1-researcher structured result" });
      expect(events.find((event) => event.type === "subagent.failed")).toBeUndefined();
      expect(events.at(-1)).toMatchObject({
        type: "team.complete",
        payload: { status: "completed", completed_tasks: 1, failed_tasks: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
