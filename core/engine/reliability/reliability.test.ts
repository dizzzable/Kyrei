import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { cleanupIncomplete } from "./cleanup.js";
import { detectLoop, toolSignature } from "./loop-detect.js";
import {
  nextHealState,
  isTerminal,
  healStrike,
  healTranscriptMarker,
  healAgentGuidance,
} from "./self-heal.js";
import { evaluateFinalAudit } from "./final-audit.js";
import { checkBudget } from "./budget.js";
import { verifyGoal } from "./goal-verifier.js";
import { detectEcosystem } from "./verify.js";
import { buildStopWhen } from "../orchestrator/stop-conditions.js";
import {
  prepareMessagesForModel,
  isBudgetBreached,
  createHealTracker,
  toolOutcomesFromSteps,
  shouldHealHandoff,
} from "./runtime.js";
import { DEFAULT_ENGINE_CONFIG } from "../types.js";

describe("cleanupIncomplete (Property 5/14)", () => {
  it("drops assistant tool-call without a matching tool-result", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "x", input: {} }] },
    ] as unknown as ModelMessage[];
    const out = cleanupIncomplete(messages);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("user");
  });

  it("keeps a valid tool-call + tool-result pair", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "x", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "x", output: "ok" }] },
    ] as unknown as ModelMessage[];
    expect(cleanupIncomplete(messages)).toHaveLength(2);
  });

  it("drops orphan tool-result without a matching call", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "zzz", toolName: "x", output: "ok" }] },
    ] as unknown as ModelMessage[];
    const out = cleanupIncomplete(messages);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("user");
  });
});

describe("loop detection", () => {
  it("flags 3 identical consecutive tool calls", () => {
    const sig = toolSignature("run_command", { command: "ls" });
    expect(detectLoop([sig, sig, sig])).toBe(true);
  });
  it("does not flag varied calls", () => {
    expect(detectLoop([toolSignature("a", {}), toolSignature("b", {}), toolSignature("a", {})])).toBe(false);
  });

  it("stops the live loop after three identical consecutive tool calls", async () => {
    const reasons: string[] = [];
    const conditions = buildStopWhen(
      { maxSteps: 12 } as never,
      (reason) => reasons.push(reason),
    );
    const steps = [0, 1, 2].map((stepNumber) => ({
      stepNumber,
      toolCalls: [{ toolName: "read_file", input: { path: "same.ts" } }],
    })) as never;

    expect(await conditions[0]!({ steps })).toBe(true);
    expect(reasons).toEqual(["repeated_tool_call"]);
  });

  it("keeps running when similar reads target different files", async () => {
    const conditions = buildStopWhen({ maxSteps: 12 } as never);
    const steps = ["a.ts", "b.ts", "c.ts"].map((path, stepNumber) => ({
      stepNumber,
      toolCalls: [{ toolName: "read_file", input: { path } }],
    })) as never;

    expect(await conditions[0]!({ steps })).toBe(false);
  });
});

describe("self-heal FSM", () => {
  it("advances probe→retry→fix_retry→handoff on failures", () => {
    expect(nextHealState("probe", "failure")).toBe("retry");
    expect(nextHealState("retry", "failure")).toBe("fix_retry");
    expect(nextHealState("fix_retry", "failure")).toBe("handoff");
    expect(isTerminal("handoff")).toBe(true);
  });
  it("success → done", () => {
    expect(nextHealState("retry", "success")).toBe("done");
    expect(isTerminal("done")).toBe(true);
  });
  it("maps states to Wave A 3-strike markers and guidance", () => {
    expect(healStrike("probe")).toBe(1);
    expect(healStrike("retry")).toBe(2);
    expect(healStrike("fix_retry")).toBe(2);
    expect(healStrike("handoff")).toBe(3);
    expect(healTranscriptMarker("probe")).toBe("KYREI_FAILURE_PROBE");
    expect(healTranscriptMarker("retry")).toBe("KYREI_FAILURE_ESCALATE");
    expect(healTranscriptMarker("handoff")).toBe("KYREI_FAILURE_HANDOFF");
    expect(healAgentGuidance("handoff")).toContain("KYREI_FAILURE_HANDOFF");
  });
});

describe("final audit", () => {
  it("is clean only when criteria, commands, and deliverables pass", () => {
    const clean = evaluateFinalAudit({
      criteria: [{ criterion: "tests", pass: true, evidence: "npm test exit 0" }],
      commands: [{ name: "npm run gate", exitCode: 0 }],
      deliverables: [{ path: "src/app.ts", present: true }],
    });
    expect(clean.clean).toBe(true);
    expect(clean.gaps).toEqual([]);
    expect(clean.transcriptBlock).toContain("KYREI_FINAL_AUDIT");
    expect(clean.transcriptBlock).toContain("KYREI_AUDIT_COMPLETE");
    expect(clean.transcriptBlock).toContain("KYREI_RUN_COMPLETE");

    const dirty = evaluateFinalAudit({
      criteria: [{ criterion: "tests", pass: false }],
      commands: [{ name: "npm test", exitCode: 1 }],
      deliverables: [{ path: "missing.ts", present: false }],
      cleanlinessIssues: ["left TODO in patch"],
    });
    expect(dirty.clean).toBe(false);
    expect(dirty.gaps.length).toBeGreaterThanOrEqual(3);
    expect(dirty.transcriptBlock).toContain("KYREI_AUDIT_GAPS");
    expect(dirty.transcriptBlock).not.toContain("KYREI_RUN_COMPLETE");
  });

  it("rejects empty evidence (not_observed ≠ absent / no false green)", () => {
    const empty = evaluateFinalAudit({
      criteria: [],
      commands: [],
      deliverables: [],
    });
    expect(empty.clean).toBe(false);
    expect(empty.coverage).toBe(0);
    expect(empty.gaps.some((g) => g.startsWith("no_evidence_provided"))).toBe(true);
    expect(empty.transcriptBlock).toContain("KYREI_AUDIT_GAPS");
    expect(empty.transcriptBlock).not.toContain("KYREI_RUN_COMPLETE");
  });
});

describe("budget", () => {
  it("breaches on exceeded limits", () => {
    expect(checkBudget({ maxTokens: 100 }, { tokens: 150 }).breached).toBe(true);
    expect(checkBudget({ maxSteps: 10 }, { steps: 5 }).breached).toBe(false);
  });
});

describe("goal verifier", () => {
  it("empty condition → satisfied", async () => {
    const v = await verifyGoal(undefined, "transcript", async () => ({ satisfied: false }));
    expect(v.satisfied).toBe(true);
  });
  it("delegates to judge for real condition", async () => {
    const v = await verifyGoal("tests pass", "…", async () => ({ satisfied: false, gap: "tests failing" }));
    expect(v.satisfied).toBe(false);
    expect(v.gap).toBe("tests failing");
  });
});

describe("prepareMessagesForModel", () => {
  it("removes dangling tool calls before the model sees history", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "x", input: {} }] },
    ] as unknown as ModelMessage[];
    const out = prepareMessagesForModel(messages);
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe("user");
  });
});

describe("budget stop condition", () => {
  it("flags token budget breaches via isBudgetBreached", () => {
    const cfg = {
      ...DEFAULT_ENGINE_CONFIG,
      reliability: { goalVerify: true, maxTokens: 100 },
    };
    expect(isBudgetBreached(cfg, { tokens: 150 }).breached).toBe(true);
    expect(isBudgetBreached(cfg, { tokens: 50 }).breached).toBe(false);
  });

  it("stops the live loop when token budget is exceeded", async () => {
    const reasons: string[] = [];
    const conditions = buildStopWhen(
      { ...DEFAULT_ENGINE_CONFIG, maxSteps: 50, reliability: { goalVerify: true, maxTokens: 10 } },
      (reason) => reasons.push(reason),
    );
    const steps = [{
      stepNumber: 0,
      toolCalls: [],
      usage: { totalTokens: 50 },
    }] as never;
    // conditions: [repeated, healHandoff, budget, stepLimit]
    expect(await conditions[2]!({ steps })).toBe(true);
    expect(reasons).toContain("budget_exceeded");
  });
});

describe("heal tracker", () => {
  it("advances toward handoff on consecutive failures then resets on success", () => {
    const heal = createHealTracker();
    expect(heal.marker).toBe("KYREI_FAILURE_PROBE");
    expect(heal.onToolOutcome(false)).toBe("retry");
    expect(heal.marker).toBe("KYREI_FAILURE_ESCALATE");
    expect(heal.onToolOutcome(false)).toBe("fix_retry");
    expect(heal.onToolOutcome(false)).toBe("handoff");
    expect(heal.marker).toBe("KYREI_FAILURE_HANDOFF");
    expect(heal.guidance).toContain("HANDOFF");
    expect(heal.onToolOutcome(true)).toBe("done");
  });
});

describe("toolOutcomesFromSteps / shouldHealHandoff", () => {
  it("reads tool-error and tool-result from step content", () => {
    const outcomes = toolOutcomesFromSteps([
      { content: [{ type: "tool-error" }, { type: "tool-result" }] },
      { content: [{ type: "tool-error" }] },
    ]);
    expect(outcomes).toEqual([false, true, false]);
    expect(shouldHealHandoff([false, false, false])).toBe(true);
    expect(shouldHealHandoff([false, false, true])).toBe(false);
  });
});

describe("heal handoff stop condition", () => {
  it("stops after three consecutive hard tool-errors", async () => {
    const reasons: string[] = [];
    const conditions = buildStopWhen(
      { ...DEFAULT_ENGINE_CONFIG, reliability: { goalVerify: true, healHandoff: true } },
      (reason) => reasons.push(reason),
    );
    const steps = [0, 1, 2].map((stepNumber) => ({
      stepNumber,
      toolCalls: [{ toolName: "run_command", input: { command: "fail" } }],
      content: [{ type: "tool-error", toolName: "run_command", error: "boom" }],
      toolResults: [],
    })) as never;
    // conditions: [repeated, healHandoff, budget, stepLimit]
    expect(await conditions[1]!({ steps })).toBe(true);
    expect(reasons).toContain("heal_handoff");
  });

  it("does not stop when healHandoff is disabled", async () => {
    const conditions = buildStopWhen({
      ...DEFAULT_ENGINE_CONFIG,
      reliability: { goalVerify: true, healHandoff: false },
    });
    const steps = [0, 1, 2].map((stepNumber) => ({
      stepNumber,
      toolCalls: [{ toolName: "run_command", input: {} }],
      content: [{ type: "tool-error", toolName: "run_command", error: "x" }],
      toolResults: [],
    })) as never;
    expect(await conditions[1]!({ steps })).toBe(false);
  });

  it("resets failure streak after a successful tool-result", async () => {
    const conditions = buildStopWhen({
      ...DEFAULT_ENGINE_CONFIG,
      reliability: { goalVerify: true, healHandoff: true },
    });
    const steps = [
      { content: [{ type: "tool-error" }], toolResults: [], toolCalls: [{ toolName: "a", input: {} }] },
      { content: [{ type: "tool-error" }], toolResults: [], toolCalls: [{ toolName: "b", input: {} }] },
      { content: [{ type: "tool-result" }], toolResults: [{}], toolCalls: [{ toolName: "c", input: {} }] },
      { content: [{ type: "tool-error" }], toolResults: [], toolCalls: [{ toolName: "d", input: {} }] },
    ] as never;
    expect(await conditions[1]!({ steps })).toBe(false);
  });
});

describe("ecosystem detection", () => {
  it("detects node + typescript", () => {
    const cmds = detectEcosystem(["package.json", "tsconfig.json", "README.md"]);
    expect(cmds.map((c) => c.ecosystem)).toContain("node");
    expect(cmds.map((c) => c.ecosystem)).toContain("typescript");
  });
  it("empty when no markers", () => {
    expect(detectEcosystem(["README.md"])).toHaveLength(0);
  });
});
