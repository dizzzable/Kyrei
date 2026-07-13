import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIPELINE_LIMITS,
  MAX_PIPELINE_DEFINITIONS,
  MAX_PIPELINE_STAGES,
  PIPELINE_VERSION,
  createDefaultCodingPipeline,
  normalizePipelines,
  validatePipelinesInput,
} from "../core/pipeline-config.js";

const profiles = [
  { id: "research-team", enabled: true },
  { id: "planning-team", enabled: true },
  { id: "executor-team", enabled: true },
  { id: "test-team", enabled: true },
  { id: "disabled-team", enabled: false },
];

function codingPipeline() {
  return createDefaultCodingPipeline({
    research: "research-team",
    planning: "planning-team",
    execution: "executor-team",
    verification: "test-team",
  });
}

describe("Pipeline v1 config", () => {
  it("migrates missing config to an empty v1 envelope", () => {
    expect(normalizePipelines(undefined, profiles)).toEqual({
      version: PIPELINE_VERSION,
      generation: 0,
      definitions: [],
    });
  });

  it("builds and strictly validates the safe default coding pipeline", () => {
    const definition = codingPipeline();
    const result = validatePipelinesInput({ version: 1, definitions: [definition] }, profiles);

    expect(result.definitions[0]).toMatchObject({
      id: "coding-product",
      revision: 1,
      enabled: true,
      limits: DEFAULT_PIPELINE_LIMITS,
    });
    expect(result.definitions[0]?.stages.map((stage: { kind: string }) => stage.kind)).toEqual([
      "department",
      "department",
      "approval",
      "department",
      "action",
      "department",
      "truth-gate",
    ]);
  });

  it("clamps tolerant budgets and strips unknown fields including credential-shaped values", () => {
    const definition = codingPipeline();
    const result = normalizePipelines({
      version: 99,
      apiKey: "root-secret",
      definitions: [{
        ...definition,
        secret: "definition-secret",
        limits: {
          maxInputTokens: 99_000_000,
          maxOutputTokens: 99_000_000,
          maxTotalTokens: 1_000,
          maxCalls: 1,
          maxWallTimeMs: 99,
          maxRepairCycles: 99,
          maxAssistanceRequests: 99,
          maxConcurrency: 99,
        },
        stages: definition.stages.map((stage) => ({
          ...stage,
          apiKey: "stage-secret",
          headers: { Authorization: "bearer-secret" },
        })),
      }],
    }, profiles);

    expect(result.version).toBe(1);
    expect(result.definitions[0]?.limits).toEqual({
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxTotalTokens: 1_000,
      maxCalls: 1,
      maxCostUsd: 100,
      maxWallTimeMs: 1_000,
      maxRepairCycles: 1,
      maxAssistanceRequests: 1,
      maxConcurrency: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/root-secret|definition-secret|stage-secret|bearer-secret|Authorization/);
  });

  it("keeps dangling and disabled Team references visible but disabled", () => {
    for (const teamProfileId of ["missing-team", "disabled-team"]) {
      const definition = codingPipeline();
      definition.stages[0] = { ...definition.stages[0], teamProfileId };
      const result = normalizePipelines({ version: 1, definitions: [definition] }, profiles);
      expect(result.definitions[0]).toMatchObject({
        id: "coding-product",
        enabled: false,
        disabledReason: "pipeline_stage_profile_unavailable",
      });
      expect(result.definitions[0]?.stages[0]).toMatchObject({ teamProfileId });
    }
  });

  it("keeps duplicate persisted definitions visible but disables the renamed collision", () => {
    const definition = codingPipeline();
    const result = normalizePipelines({ version: 1, definitions: [definition, definition] }, profiles);
    expect(result.definitions).toMatchObject([
      { id: "coding-product", enabled: true },
      { id: "coding-product-2", enabled: false, disabledReason: "pipeline_definition_id_duplicate" },
    ]);
  });

  it("strictly rejects dangling or disabled Team references", () => {
    for (const teamProfileId of ["missing-team", "disabled-team"]) {
      const definition = codingPipeline();
      definition.stages[0] = { ...definition.stages[0], teamProfileId };
      expect(() => validatePipelinesInput({ version: 1, definitions: [definition] }, profiles))
        .toThrow("pipeline_stage_profile_unavailable");
    }
  });

  it("rejects dependency cycles, self references, and dangling edges", () => {
    const cyclic = codingPipeline();
    cyclic.stages[0] = { ...cyclic.stages[0], dependsOn: ["planning"] };
    expect(() => validatePipelinesInput({ version: 1, definitions: [cyclic] }, profiles))
      .toThrow("pipeline_graph_cycle");

    const self = codingPipeline();
    self.stages[0] = { ...self.stages[0], dependsOn: ["research"] };
    expect(() => validatePipelinesInput({ version: 1, definitions: [self] }, profiles))
      .toThrow("pipeline_stage_dependency_unavailable");

    const dangling = codingPipeline();
    dangling.stages[1] = { ...dangling.stages[1], dependsOn: ["lost-stage"] };
    expect(() => validatePipelinesInput({ version: 1, definitions: [dangling] }, profiles))
      .toThrow("pipeline_stage_dependency_unavailable");
  });

  it("rejects actions without prior approval or a later truth gate", () => {
    const noApproval = codingPipeline();
    noApproval.stages[3] = { ...noApproval.stages[3], dependsOn: ["planning"] };
    expect(() => validatePipelinesInput({ version: 1, definitions: [noApproval] }, profiles))
      .toThrow("pipeline_transition_unsafe");

    const noGate = codingPipeline();
    noGate.stages = noGate.stages.filter((stage) => stage.kind !== "truth-gate");
    expect(() => validatePipelinesInput({ version: 1, definitions: [noGate] }, profiles))
      .toThrow("pipeline_transition_unsafe");

    const partiallyApproved = codingPipeline();
    partiallyApproved.stages.push({
      id: "unapproved-work",
      name: "Unapproved work",
      kind: "department",
      teamProfileId: "research-team",
      dependsOn: [],
      allowedHelpFrom: [],
      retry: { maxAttempts: 1, backoffMs: 0 },
    });
    partiallyApproved.stages[4] = {
      ...partiallyApproved.stages[4],
      dependsOn: ["implementation", "unapproved-work"],
    };
    expect(() => validatePipelinesInput({ version: 1, definitions: [partiallyApproved] }, profiles))
      .toThrow("pipeline_transition_unsafe");
  });

  it("rejects action identifiers that are not implemented by the control plane", () => {
    const definition = codingPipeline();
    definition.stages[4] = { ...definition.stages[4], action: "workspace.delete" };
    expect(() => validatePipelinesInput({ version: 1, definitions: [definition] }, profiles))
      .toThrow("pipeline_stage_action_invalid");
    expect(normalizePipelines({ version: 1, definitions: [definition] }, profiles).definitions[0])
      .toMatchObject({ enabled: false, disabledReason: "pipeline_stage_action_invalid" });
  });

  it("rejects unsafe roots, non-ancestor help, non-department help, and repeated actions", () => {
    const actionRoot = codingPipeline();
    actionRoot.stages[4] = { ...actionRoot.stages[4], dependsOn: [] };
    expect(() => validatePipelinesInput({ version: 1, definitions: [actionRoot] }, profiles))
      .toThrow("pipeline_transition_unsafe");

    const futureHelp = codingPipeline();
    futureHelp.stages[1] = { ...futureHelp.stages[1], allowedHelpFrom: ["verification"] };
    expect(() => validatePipelinesInput({ version: 1, definitions: [futureHelp] }, profiles))
      .toThrow("pipeline_transition_unsafe");

    const approvalHelp = codingPipeline();
    approvalHelp.stages[2] = { ...approvalHelp.stages[2], allowedHelpFrom: ["research"] };
    expect(() => validatePipelinesInput({ version: 1, definitions: [approvalHelp] }, profiles))
      .toThrow("pipeline_transition_unsafe");

    const repeatedAction = codingPipeline();
    repeatedAction.stages[4] = {
      ...repeatedAction.stages[4],
      retry: { maxAttempts: 2, backoffMs: 1_000 },
    };
    expect(() => validatePipelinesInput({ version: 1, definitions: [repeatedAction] }, profiles))
      .toThrow("pipeline_transition_unsafe");
  });

  it("strictly enforces schema version, stable ids, bounded retry, and related limits", () => {
    const definition = codingPipeline();
    expect(() => validatePipelinesInput({ version: 2, definitions: [definition] }, profiles))
      .toThrow("pipeline_version_invalid");

    const badRetry = codingPipeline();
    badRetry.stages[0] = { ...badRetry.stages[0], retry: { maxAttempts: 6, backoffMs: 1_000 } };
    expect(() => validatePipelinesInput({ version: 1, definitions: [badRetry] }, profiles))
      .toThrow("pipeline_stage_retry_maxAttempts");

    const badLimits = codingPipeline();
    badLimits.limits = { ...badLimits.limits, maxCalls: 1, maxConcurrency: 2 };
    expect(() => validatePipelinesInput({ version: 1, definitions: [badLimits] }, profiles))
      .toThrow("pipeline_limit_maxConcurrency");
  });

  it("applies defensive collection caps without accepting empty enabled definitions", () => {
    const manyStages = Array.from({ length: MAX_PIPELINE_STAGES + 20 }, (_, index) => ({
      id: `stage-${index}`,
      name: `Stage ${index}`,
      kind: "department",
      teamProfileId: "research-team",
      dependsOn: [],
      allowedHelpFrom: [],
      retry: { maxAttempts: 1, backoffMs: 0 },
    }));
    const manyDefinitions = Array.from({ length: MAX_PIPELINE_DEFINITIONS + 20 }, (_, index) => ({
      id: `pipeline-${index}`,
      name: `Pipeline ${index}`,
      revision: 1,
      enabled: true,
      stages: manyStages,
      limits: DEFAULT_PIPELINE_LIMITS,
    }));
    const result = normalizePipelines({ version: 1, definitions: manyDefinitions }, profiles);
    expect(result.definitions).toHaveLength(MAX_PIPELINE_DEFINITIONS);
    expect(result.definitions[0]?.stages).toHaveLength(MAX_PIPELINE_STAGES);

    expect(() => validatePipelinesInput({
      version: 1,
      definitions: [{ id: "empty", name: "Empty", revision: 1, enabled: true, stages: [] }],
    }, profiles)).toThrow("pipeline_stages_invalid");
  });
});
