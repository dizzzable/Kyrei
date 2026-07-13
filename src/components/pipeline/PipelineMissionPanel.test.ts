import { describe, expect, it } from "vitest";

import {
  awaitingApprovalStageId,
  pipelineBudgetSummary,
  pipelineMissionCreationErrorKey,
  pipelineRunControls,
} from "./PipelineMissionPanel";
import type { PipelineRunSnapshot } from "@/lib/types";
import { createTranslator } from "@/i18n/translate";
import { ruShell } from "@/i18n/locales/ru/shell";
import { GatewayRequestError } from "@/lib/gateway";

function mission(status: PipelineRunSnapshot["status"], stages: PipelineRunSnapshot["stages"] = []): PipelineRunSnapshot {
  return {
    schemaVersion: 1,
    sequence: 1,
    runId: "mission-1",
    pipelineId: "coding-organization",
    definitionRevision: "1",
    definitionDigest: "digest",
    runtimeFingerprint: "fingerprint",
    workspaceBaselineDigest: "baseline",
    workspaceBaselineObservedAt: "2026-07-13T00:00:00.000Z",
    workspaceCheckpointDigest: "checkpoint",
    workspaceCheckpointObservedAt: "2026-07-13T00:00:00.000Z",
    goal: "Inspect the workspace",
    workspace: "C:/workspace",
    workspaceHash: "hash",
    attachedSessionIds: [],
    stages,
    artifacts: [],
    approvals: [],
    budget: {},
    status,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  };
}

describe("pipeline mission controls", () => {
  it("ships localized Russian mission labels", () => {
    const translate = createTranslator(ruShell, "ru");
    expect(translate("shell.mission.title")).toBe("\u0423\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u0438\u0435 \u043c\u0438\u0441\u0441\u0438\u044f\u043c\u0438");
  });

  it("only offers transitions that are safe for the persisted mission status", () => {
    expect(pipelineRunControls(mission("running"))).toEqual(["pause", "cancel"]);
    expect(pipelineRunControls(mission("paused"))).toEqual(["resume", "cancel"]);
    expect(pipelineRunControls(mission("interrupted"))).toEqual(["resume", "cancel"]);
    expect(pipelineRunControls(mission("budget_paused"))).toEqual(["cancel"]);
    expect(pipelineRunControls(mission("blocked"))).toEqual(["cancel"]);
  });

  it("only exposes approval actions when the durable approval stage is waiting", () => {
    const waiting = mission("awaiting_approval", [{
      id: "approve-plan",
      name: "Plan approval",
      kind: "approval",
      dependsOn: [],
      writeCapable: false,
      status: "awaiting_approval",
      attempts: 1,
      artifactIds: [],
      uncertain: false,
    }]);

    expect(awaitingApprovalStageId(waiting)).toBe("approve-plan");
    expect(pipelineRunControls(waiting)).toEqual(["approve", "reject", "cancel"]);
    expect(pipelineRunControls(mission("awaiting_approval"))).toEqual(["cancel"]);
  });

  it("summarizes token and call budgets without trusting malformed values", () => {
    expect(pipelineBudgetSummary({
      limits: { maxTotalTokens: 100, maxCalls: 4 },
      consumed: { inputTokens: 20, outputTokens: 30, calls: 2 },
      unmeteredCalls: 1,
      exhausted: true,
    })).toEqual({
      totalTokens: 50,
      totalTokenLimit: 100,
      calls: 3,
      callLimit: 4,
      exhausted: true,
    });
  });

  it("maps stable admission codes to safe localized guidance", () => {
    const failure = (serverCode?: string) => new GatewayRequestError("request_failed", { serverCode });
    expect(pipelineMissionCreationErrorKey(failure("pipeline_workspace_evidence_limit")))
      .toBe("shell.mission.createError.workspaceTooLarge");
    expect(pipelineMissionCreationErrorKey(failure("pipeline_runtime_unavailable")))
      .toBe("shell.mission.createError.runtimeUnavailable");
    expect(pipelineMissionCreationErrorKey(failure("pipeline_workspace_changed_during_evidence")))
      .toBe("shell.mission.createError.workspaceChanging");
    expect(pipelineMissionCreationErrorKey(failure("sandbox_required_unavailable")))
      .toBe("shell.mission.createError.sandboxUnavailable");
    expect(pipelineMissionCreationErrorKey(failure("unexpected_internal_detail")))
      .toBe("shell.mission.createFailed");
  });
});
