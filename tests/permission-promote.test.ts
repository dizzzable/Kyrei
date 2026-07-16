import { describe, it, expect } from "vitest";
import {
  permissionRuleFromApproval,
  mergePermissionRule,
} from "../core/permission-promote.js";
import {
  permissionRuleFromApproval as feRule,
  mergePermissionRule as feMerge,
} from "../src/lib/permission-rules.ts";

describe("permission promote from approval", () => {
  it("builds exact command allow rule", () => {
    const rule = permissionRuleFromApproval("run_command", { command: "npm test" }, "allow");
    expect(rule?.action).toBe("allow");
    expect(rule?.pattern).toContain("run_command");
    expect(rule?.pattern).toContain("npm test");
  });

  it("builds exact path rule for write_file", () => {
    const rule = permissionRuleFromApproval("write_file", { path: "src/a.ts" }, "allow");
    expect(rule?.pattern).toContain("write_file");
    expect(rule?.pattern).toMatch(/src\/a\\\.ts|src\/a\.ts/);
  });

  it("denies absolute paths with tool-wide deny only (never tool-wide allow)", () => {
    const deny = permissionRuleFromApproval("write_file", { path: "C:\\secret\\x" }, "deny");
    expect(deny?.action).toBe("deny");
    expect(deny?.pattern.startsWith("^write_file")).toBe(true);
    const allow = permissionRuleFromApproval("write_file", { path: "C:\\secret\\x" }, "allow");
    expect(allow).toBeNull();
  });

  it("merges without duplicate patterns", () => {
    const a = permissionRuleFromApproval("run_command", { command: "ls" }, "allow")!;
    const once = mergePermissionRule([], a);
    const twice = mergePermissionRule(once, a);
    expect(twice).toHaveLength(1);
  });

  it("frontend helper agrees on command rules", () => {
    const core = permissionRuleFromApproval("run_command", { command: "git status" }, "allow");
    const fe = feRule("run_command", { command: "git status" }, "allow");
    expect(fe?.pattern).toBe(core?.pattern);
    expect(feMerge([], fe!).length).toBe(1);
  });
});
