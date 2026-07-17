import { describe, it, expect } from "vitest";
import {
  HARNESS_KARPATHY,
  HARNESS_RUN_PROTOCOL,
  HARNESS_WORKFLOW,
} from "./harness-contracts.js";

describe("harness contracts (Wave A)", () => {
  it("embeds Karpathy-class quality discipline without vendor product chrome", () => {
    expect(HARNESS_KARPATHY).toContain("Think before coding");
    expect(HARNESS_KARPATHY).toContain("Simplicity first");
    expect(HARNESS_KARPATHY).toContain("Surgical changes");
    expect(HARNESS_KARPATHY).toContain("Goal-driven execution");
    expect(HARNESS_KARPATHY).not.toMatch(/Claude|GPT-4|Codex CLI/i);
  });

  it("defines Supergoal-shaped run markers on Kyrei paths", () => {
    expect(HARNESS_RUN_PROTOCOL).toContain(".kyrei/run/");
    expect(HARNESS_RUN_PROTOCOL).toContain("KYREI_PHASE_VERIFY");
    expect(HARNESS_RUN_PROTOCOL).toContain("KYREI_FAILURE_PROBE");
    expect(HARNESS_RUN_PROTOCOL).toContain("KYREI_FAILURE_ESCALATE");
    expect(HARNESS_RUN_PROTOCOL).toContain("KYREI_FAILURE_HANDOFF");
    expect(HARNESS_RUN_PROTOCOL).toContain("KYREI_FINAL_AUDIT");
    expect(HARNESS_RUN_PROTOCOL).toContain("KYREI_RUN_COMPLETE");
    expect(HARNESS_RUN_PROTOCOL).toContain("3-strike");
  });

  it("keeps the portable agent loop dense and tool-aligned", () => {
    expect(HARNESS_WORKFLOW).toContain("edit_file");
    expect(HARNESS_WORKFLOW).toContain("Never invent");
    expect(HARNESS_WORKFLOW).toContain("Verify");
  });
});
