import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import { cleanupIncomplete } from "./cleanup.js";
import { detectLoop, toolSignature } from "./loop-detect.js";
import { nextHealState, isTerminal } from "./self-heal.js";
import { checkBudget } from "./budget.js";
import { verifyGoal } from "./goal-verifier.js";
import { detectEcosystem } from "./verify.js";

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
