import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  digestMessagesToTrajectory,
  sleepProposalsFromTrajectories,
  runSkillSleep,
  normalizeSkillsSleepConfig,
} from "../core/skills-sleep.js";

describe("skills sleep (Wave C1)", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "kyrei-sleep-"));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("normalizes config with caps", () => {
    const cfg = normalizeSkillsSleepConfig({ maxTrajectories: 9999, minFailureCluster: 0 });
    expect(cfg.maxTrajectories).toBe(200);
    expect(cfg.minFailureCluster).toBe(1);
    expect(cfg.enabled).toBe(true);
  });

  it("digests messages into trajectory signals", () => {
    const dig = digestMessagesToTrajectory(
      [
        { role: "user", content: "Fix auth bugs" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolName: "read_skill", input: { id: "security-checklist" } },
            { type: "tool-call", toolName: "run_command", input: { command: "npm test" } },
            { type: "tool-error", toolName: "run_command", error: "exit 1" },
          ],
        },
        { role: "assistant", content: "KYREI_FAILURE_HANDOFF\nblocked" },
      ],
      { sessionId: "s1", status: "heal_handoff", skillIds: ["skill_aaa"] },
    );
    expect(dig.sessionId).toBe("s1");
    expect(dig.healHandoff).toBe(true);
    expect(dig.success).toBe(false);
    expect(dig.tools).toContain("run_command");
    expect(dig.failures.some((f) => f.includes("run_command"))).toBe(true);
    expect(dig.skillNames).toContain("security-checklist");
    expect(dig.skillIds).toContain("skill_aaa");
  });

  it("proposes recovery patches when failures cluster on a skill", () => {
    const skill = {
      id: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
      name: "security-checklist",
      description: "Security checklist for local agents",
      enabled: true,
      owned: true,
      content: "---\nname: security-checklist\ndescription: Security checklist for local agents\n---\n\n# Security\n",
    };
    const proposals = sleepProposalsFromTrajectories(
      [
        {
          skillIds: [skill.id],
          failures: ["run_command: exit 1", "edit_file: patch failed"],
          success: false,
          tools: ["run_command", "edit_file"],
        },
        {
          skillIds: [skill.id],
          failures: ["run_command: exit 1"],
          success: false,
          healHandoff: true,
        },
      ],
      [skill],
      { minFailureCluster: 2 },
    );
    expect(proposals.some((p) => p.kind === "sleep_improve" && p.action === "suggest_patch")).toBe(true);
    const patch = proposals.find((p) => p.kind === "sleep_improve");
    expect(String(patch?.suggestedContent || "")).toContain("Sleep-suggested recovery");
  });

  it("drafts a new skill when orphan tool patterns repeat", () => {
    const proposals = sleepProposalsFromTrajectories(
      [
        { tools: ["web_fetch", "web_search"], failures: ["web_fetch: timeout"], success: false },
        { tools: ["web_fetch"], failures: ["web_fetch: 404"], success: false },
      ],
      [],
      { minFailureCluster: 1 },
    );
    expect(proposals.some((p) => p.kind === "sleep_new_skill")).toBe(true);
  });

  it("writes a propose-only envelope under skills-curator", async () => {
    const result = await runSkillSleep({
      dataDir,
      trajectories: [
        {
          skillIds: ["skill_aaaaaaaaaaaaaaaaaaaaaaaa"],
          failures: ["x", "y"],
          success: false,
        },
        {
          skillIds: ["skill_aaaaaaaaaaaaaaaaaaaaaaaa"],
          failures: ["x"],
          success: false,
        },
      ],
      skills: [
        {
          id: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
          name: "demo",
          description: "A reasonably long description for matching.",
          owned: true,
          enabled: true,
          content: "---\nname: demo\n---\n\n# Demo\n",
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.fileName).toMatch(/^sleep-/);
    const dir = join(dataDir, "skills-curator");
    const files = await readdir(dir);
    expect(files.some((f) => f.startsWith("sleep-"))).toBe(true);
    const body = JSON.parse(await readFile(join(dir, result.fileName!), "utf8")) as {
      via: string;
      applyMode: string;
      status: string;
    };
    expect(body.via).toBe("skill_sleep");
    expect(body.applyMode).toBe("propose");
    expect(body.status).toBe("pending");
  });
});
