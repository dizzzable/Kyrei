import { describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { buildSkillTools } from "./skills.js";

const skills = [
  {
    id: "skill-review",
    name: "Code review",
    description: "Review TypeScript changes",
    provenance: "global" as const,
    content: "# Review\n\nCheck correctness before style.",
  },
];

async function execute(tools: ToolSet, args: unknown): Promise<string> {
  const definition = tools["read_skill"] as { execute: (input: unknown, options: unknown) => Promise<unknown> };
  return String(await definition.execute(args, { toolCallId: "skill-test", messages: [] }));
}

describe("Agent Skills tool", () => {
  it("does not expose a tool when no skills are enabled", () => {
    expect(buildSkillTools([])).toEqual({});
  });

  it("loads only a known skill and records usage", async () => {
    const onUsed = vi.fn();
    const tools = buildSkillTools(skills, { onUsed });

    await expect(execute(tools, { id: "skill-review" })).resolves.toContain("Check correctness");
    expect(onUsed).toHaveBeenCalledWith("skill-review");
  });

  it("never reveals the available documents for an unknown id", async () => {
    const output = await execute(buildSkillTools(skills), { id: "missing" });
    expect(output).toBe("Skill is unavailable or disabled.");
    expect(output).not.toContain("Code review");
  });

  it("clips model-visible skill content", async () => {
    const noisy = [{ ...skills[0], content: "x".repeat(10_000) }];
    const output = await execute(buildSkillTools(noisy, { maxOutputChars: 800 }), { id: "skill-review" });
    expect(output.length).toBeLessThanOrEqual(800);
    expect(output).toContain("skill content truncated");
  });
});
