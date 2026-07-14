import { describe, expect, it } from "vitest";

import {
  MAX_PERMISSION_RULE_PATTERN_LENGTH,
  MAX_PERMISSION_RULES,
  canonicalizePermissionPathTarget,
  classifyPermissionRule,
  createExactCommandPermissionRule,
  createExactPathPermissionRule,
  createExactToolPermissionRule,
  guidedPermissionRuleIdentity,
  importPermissionRules,
  permissionRuleMatches,
  permissionToolSupportsInteractiveAsk,
  resolvePermissionRuleAction,
  type PermissionRule,
} from "./permission-rules";

describe("guided permission rules", () => {
  it("creates an anchored, escaped exact tool rule", () => {
    const rule = createExactToolPermissionRule("mcp.tool+read", "ask");

    expect(rule).toEqual({ pattern: "^mcp\\.tool\\+read(?::[\\s\\S]*)?$(?![\\s\\S])", action: "ask" });
    expect(permissionRuleMatches(rule, "mcp.tool+read")).toBe(true);
    expect(permissionRuleMatches(rule, "mcp.tool+read:one exact tool target")).toBe(true);
    expect(permissionRuleMatches(rule, "mcpXtool+read")).toBe(false);
    expect(permissionRuleMatches(rule, "mcp.tool+reader:target")).toBe(false);
    expect(permissionRuleMatches(rule, "mcp.tool+read\n")).toBe(false);
    expect(classifyPermissionRule(rule)).toEqual({
      mode: "generated",
      kind: "tool",
      tool: "mcp.tool+read",
    });
  });

  it("preserves and escapes the exact run_command input", () => {
    const command = "npm test -- --grep \"[unit].*\"\nexit 0";
    const rule = createExactCommandPermissionRule(command, "allow");

    expect(permissionRuleMatches(rule, `run_command:${command}`)).toBe(true);
    expect(permissionRuleMatches(rule, `run_command:${command} `)).toBe(false);
    expect(permissionRuleMatches(rule, "run_command:npm test -- --grep \"unit-anything\"")).toBe(false);
    expect(classifyPermissionRule(rule)).toEqual({
      mode: "generated",
      kind: "command",
      tool: "run_command",
      command,
    });
  });

  it("canonicalizes a workspace-relative target before escaping it", () => {
    const rule = createExactPathPermissionRule("write_file", ".\\src\\feature\\..\\file[1].ts", "deny");

    expect(rule.pattern).toBe("^write_file:src/file\\[1\\]\\.ts$(?![\\s\\S])");
    expect(permissionRuleMatches(rule, "write_file:src/file[1].ts")).toBe(true);
    expect(permissionRuleMatches(rule, "write_file:src/file11.ts")).toBe(false);
    expect(classifyPermissionRule(rule)).toEqual({
      mode: "generated",
      kind: "path",
      tool: "write_file",
      target: "src/file[1].ts",
    });
  });

  it("rejects absolute and workspace-escaping path targets", () => {
    expect(() => canonicalizePermissionPathTarget("../secret.txt")).toThrow("permission_rule_path_escape");
    expect(() => canonicalizePermissionPathTarget("C:\\outside.txt")).toThrow("permission_rule_path_absolute");
    expect(() => canonicalizePermissionPathTarget("/outside.txt")).toThrow("permission_rule_path_absolute");
    expect(() => canonicalizePermissionPathTarget("src/..")).toThrow("permission_rule_path_invalid");
  });

  it("classifies legacy exact rules as generated and real regex as advanced", () => {
    expect(classifyPermissionRule({ pattern: "^diagnostics$", action: "allow" })).toEqual({
      mode: "generated",
      kind: "tool",
      tool: "diagnostics",
    });
    expect(classifyPermissionRule({ pattern: "^edit_file:src/a\\.ts$", action: "ask" })).toEqual({
      mode: "generated",
      kind: "path",
      tool: "edit_file",
      target: "src/a.ts",
    });
    expect(classifyPermissionRule({ pattern: "^run_command:npm (test|lint)$", action: "ask" })).toEqual({
      mode: "advanced",
      kind: "advanced",
    });
    expect(classifyPermissionRule({ pattern: "[", action: "deny" })).toEqual({
      mode: "invalid",
      kind: "invalid",
      error: "pattern_invalid",
    });
  });

  it("finds Windows-equivalent guided identities without executing advanced regex", () => {
    const upper = createExactPathPermissionRule("edit_file", "src/App.tsx", "allow");
    const lower = createExactPathPermissionRule("edit_file", "SRC/app.tsx", "deny");

    expect(guidedPermissionRuleIdentity(upper)).not.toBe(guidedPermissionRuleIdentity(lower));
    expect(guidedPermissionRuleIdentity(upper, { caseInsensitive: true }))
      .toBe(guidedPermissionRuleIdentity(lower, { caseInsensitive: true }));
    expect(guidedPermissionRuleIdentity({ pattern: "^edit_file:src/(a|b)\\.ts$", action: "deny" }))
      .toBeUndefined();
  });

  it("does not advertise an approval path for agent web tools", () => {
    expect(permissionToolSupportsInteractiveAsk("run_command")).toBe(true);
    expect(permissionToolSupportsInteractiveAsk("diagnostics")).toBe(true);
    expect(permissionToolSupportsInteractiveAsk("web_search")).toBe(false);
    expect(permissionToolSupportsInteractiveAsk("web_fetch")).toBe(false);
  });
});

describe("permission rule import and resolution", () => {
  it("keeps valid generated and advanced rules in source order", () => {
    const input = [
      createExactToolPermissionRule("diagnostics", "allow"),
      { pattern: "[", action: "deny" },
      { pattern: "release|publish", action: "ask" },
      { pattern: "^run_command:npm test$", action: "deny" },
      { pattern: ".*", action: "sometimes" },
    ];

    const imported = importPermissionRules(input);

    expect(imported.rules).toEqual([input[0], input[2], input[3]]);
    expect(imported.entries.map((entry) => entry.classification.mode)).toEqual([
      "generated",
      "advanced",
      "generated",
    ]);
    expect(imported.issues).toEqual([
      { index: 1, code: "pattern_invalid" },
      { index: 4, code: "action_invalid" },
    ]);
  });

  it("bounds imported patterns before compilation", () => {
    const imported = importPermissionRules([
      { pattern: "a".repeat(MAX_PERMISSION_RULE_PATTERN_LENGTH + 1), action: "deny" },
    ]);

    expect(imported.rules).toEqual([]);
    expect(imported.issues).toEqual([{ index: 0, code: "pattern_too_long" }]);
    expect(importPermissionRules({})).toEqual({
      rules: [],
      entries: [],
      issues: [{ index: -1, code: "rules_not_array" }],
    });
    expect(importPermissionRules([{ pattern: "^tool:\n$", action: "deny" }]).issues).toEqual([
      { index: 0, code: "pattern_control" },
    ]);
  });

  it("caps imported rules to the same 128-entry gateway boundary", () => {
    const input = Array.from({ length: MAX_PERMISSION_RULES + 1 }, (_, index) => ({
      pattern: `^tool_${index}$`,
      action: "allow" as const,
    }));

    const imported = importPermissionRules(input);

    expect(imported.rules).toHaveLength(MAX_PERMISSION_RULES);
    expect(imported.rules.at(-1)).toEqual(input[MAX_PERMISSION_RULES - 1]);
    expect(imported.issues).toEqual([{ index: MAX_PERMISSION_RULES, code: "rules_too_many" }]);
  });

  it("never executes an invalid pattern while matching", () => {
    const invalid = { pattern: "[", action: "deny" } as PermissionRule;

    expect(permissionRuleMatches(invalid, "anything")).toBe(false);
    expect(resolvePermissionRuleAction([invalid], "anything")).toBeUndefined();
  });

  it("uses deny over ask over allow without reordering rules", () => {
    const rules: PermissionRule[] = [
      { pattern: "npm", action: "allow" },
      { pattern: "release", action: "ask" },
      { pattern: "run_command", action: "deny" },
    ];

    expect(resolvePermissionRuleAction(rules, "run_command:npm release")).toBe("deny");
    expect(resolvePermissionRuleAction(rules.slice(0, 2), "run_command:npm release")).toBe("ask");
    expect(resolvePermissionRuleAction(rules.slice(0, 1), "run_command:npm test")).toBe("allow");
    expect(rules.map((rule) => rule.action)).toEqual(["allow", "ask", "deny"]);
  });

  it("can preview the backend's Windows case-insensitive matching", () => {
    const rule = createExactPathPermissionRule("edit_file", "src/App.tsx", "deny");

    expect(permissionRuleMatches(rule, "edit_file:SRC/APP.TSX")).toBe(false);
    expect(permissionRuleMatches(rule, "edit_file:SRC/APP.TSX", { caseInsensitive: true })).toBe(true);
  });
});
