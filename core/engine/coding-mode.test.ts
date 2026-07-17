import { describe, expect, it } from "vitest";
import {
  codingModeAssignmentRole,
  codingModeForPipelineStage,
  codingModePrefersReadOnly,
  codingModePrompt,
  detectCodingModeSwitch,
  effectiveCodingModeFromMessages,
  filterToolsForCodingMode,
  isCodingMode,
  isPlanModeBlockedTool,
  normalizeCodingMode,
  PLAN_MODE_BLOCKED_TOOLS,
  suggestedReasoningEffort,
  textFromMessageContent,
} from "./coding-mode.js";

describe("coding-mode", () => {
  it("normalizes and validates modes", () => {
    expect(isCodingMode("build")).toBe(true);
    expect(isCodingMode("deepreep")).toBe(true);
    expect(isCodingMode("nope")).toBe(false);
    expect(normalizeCodingMode("polish")).toBe("polish");
    expect(normalizeCodingMode("balanced")).toBe("auto");
    expect(normalizeCodingMode("x")).toBe("auto");
  });

  it("returns distinct prompt contracts", () => {
    expect(codingModePrompt("build")).toContain("BUILD");
    expect(codingModePrompt("polish")).toContain("POLISH");
    expect(codingModePrompt("plan")).toContain("PLAN");
    expect(codingModePrompt("deepreep")).toContain("DEEPREEP");
    expect(codingModePrompt("auto")).toContain("AUTO");
    expect(codingModePrompt("auto")).toContain("Long-horizon");
    expect(codingModePrompt("build")).not.toEqual(codingModePrompt("polish"));
  });

  it("suggests higher effort for polish and deepreep", () => {
    expect(suggestedReasoningEffort("polish")).toBe("xhigh");
    expect(suggestedReasoningEffort("deepreep")).toBe("xhigh");
    expect(suggestedReasoningEffort("build")).toBe("high");
    expect(suggestedReasoningEffort("plan")).toBe("high");
    expect(suggestedReasoningEffort("auto")).toBe("medium");
  });

  it("marks plan as prefer-read-only", () => {
    expect(codingModePrefersReadOnly("plan")).toBe(true);
    expect(codingModePrefersReadOnly("build")).toBe(false);
  });

  it("maps modes to assignment roles", () => {
    expect(codingModeAssignmentRole("build")).toBe("build");
    expect(codingModeAssignmentRole("auto")).toBeNull();
    expect(codingModeAssignmentRole("deepreep")).toBe("deepreep");
  });

  it("hard-gates mutating tools in plan mode only", () => {
    const tools = {
      read_file: {},
      edit_file: {},
      write_file: {},
      run_command: {},
      plan_read: {},
      plan_write_roadmap: {},
      web_search: {},
      team_delegate: {},
      record_decision: {},
      invalidate_decision: {},
      memory_search: {},
      memory_ask: {},
      query_decisions: {},
      fetch_decision: {},
    };
    const plan = filterToolsForCodingMode(tools, "plan");
    expect(plan).toBeDefined();
    expect(plan).not.toHaveProperty("edit_file");
    expect(plan).not.toHaveProperty("write_file");
    expect(plan).not.toHaveProperty("run_command");
    expect(plan).not.toHaveProperty("team_delegate");
    expect(plan).not.toHaveProperty("record_decision");
    expect(plan).not.toHaveProperty("invalidate_decision");
    expect(plan).toHaveProperty("read_file");
    expect(plan).toHaveProperty("plan_write_roadmap");
    expect(plan).toHaveProperty("web_search");
    expect(plan).toHaveProperty("memory_search");
    expect(plan).toHaveProperty("memory_ask");
    expect(plan).toHaveProperty("query_decisions");
    expect(plan).toHaveProperty("fetch_decision");
    for (const name of PLAN_MODE_BLOCKED_TOOLS) {
      expect(plan).not.toHaveProperty(name);
    }
    expect(filterToolsForCodingMode(tools, "build")).toEqual(tools);
    expect(filterToolsForCodingMode(tools, "auto")).toEqual(tools);
  });

  it("maps pipeline department stages to coding modes", () => {
    expect(codingModeForPipelineStage({ id: "research" })).toBe("deepreep");
    expect(codingModeForPipelineStage({ id: "deep-research", name: "Scout" })).toBe("deepreep");
    expect(codingModeForPipelineStage({ id: "planning" })).toBe("plan");
    expect(codingModeForPipelineStage({ id: "design", name: "Architecture" })).toBe("plan");
    expect(codingModeForPipelineStage({ id: "implementation" })).toBe("build");
    expect(codingModeForPipelineStage({ id: "build", name: "Code" })).toBe("build");
    expect(codingModeForPipelineStage({ id: "verification" })).toBe("polish");
    expect(codingModeForPipelineStage({ id: "qa-review" })).toBe("polish");
    expect(codingModeForPipelineStage({ id: "misc" })).toBe("auto");
    // Non-department stages stay auto (team members, etc.)
    expect(codingModeForPipelineStage({ id: "research", kind: "team" })).toBe("auto");
    expect(codingModeForPipelineStage({ id: "research", kind: "department" })).toBe("deepreep");
  });

  it("detects mode switch declarations from assistant text (last match wins)", () => {
    expect(detectCodingModeSwitch("")).toBeNull();
    expect(detectCodingModeSwitch("Let us plan the feature carefully.")).toBeNull();
    expect(detectCodingModeSwitch("Effective phase: plan — need a roadmap first.")).toBe("plan");
    expect(detectCodingModeSwitch("MODE_SWITCH: build\nImplementing now.")).toBe("build");
    expect(detectCodingModeSwitch("[[mode: polish]]")).toBe("polish");
    expect(detectCodingModeSwitch("Please run /mode deepreep")).toBe("deepreep");
    expect(
      detectCodingModeSwitch("Effective phase: plan — research.\n\nLater: MODE_SWITCH: build"),
    ).toBe("build");
    expect(detectCodingModeSwitch("Effective phase: AUTO — still choosing.")).toBe("auto");
  });

  it("resolves effective mode from auto + assistant phase lines", () => {
    expect(effectiveCodingModeFromMessages([], "plan")).toBe("plan");
    expect(effectiveCodingModeFromMessages([
      { role: "user", content: "ship it" },
      { role: "assistant", content: "Effective phase: plan — need a design first." },
    ], "auto")).toBe("plan");
    expect(effectiveCodingModeFromMessages([
      { role: "assistant", content: [{ type: "text", text: "MODE_SWITCH: polish" }] },
    ], "auto")).toBe("polish");
    expect(effectiveCodingModeFromMessages([
      { role: "assistant", content: "Effective phase: plan" },
      { role: "user", content: "ok build it" },
      { role: "assistant", content: "Effective phase: build — implementing." },
    ], "auto")).toBe("build");
    // Fixed UI mode is not overridden by assistant text
    expect(effectiveCodingModeFromMessages([
      { role: "assistant", content: "Effective phase: build" },
    ], "plan")).toBe("plan");
  });

  it("extracts text from mixed message content", () => {
    expect(textFromMessageContent("plain")).toBe("plain");
    expect(textFromMessageContent([
      { type: "text", text: "a" },
      { type: "reasoning", text: "b" },
      { type: "tool-call", text: "ignored" },
    ])).toBe("a\nb");
  });

  it("knows which tools plan mode blocks", () => {
    expect(isPlanModeBlockedTool("edit_file")).toBe(true);
    expect(isPlanModeBlockedTool("read_file")).toBe(false);
  });
});
