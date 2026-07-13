import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { RuntimeSkill } from "../types.js";
import { TOOL_DESCRIPTIONS } from "../prompt/tool-descriptions.js";

export interface SkillToolOptions {
  maxOutputChars?: number;
  onUsed?: (id: string) => void | Promise<void>;
}

function clipSkill(text: string, maxOutputChars: number): string {
  const limit = Math.max(500, maxOutputChars);
  if (text.length <= limit) return text;
  const marker = "\n… [skill content truncated]";
  return `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

/**
 * Expose enabled Agent Skills through one progressive-loading tool. The model
 * receives only small metadata summaries in its system prompt and loads the
 * full markdown for a matching task by stable id.
 */
export function buildSkillTools(skills: readonly RuntimeSkill[], options: SkillToolOptions = {}): ToolSet {
  if (skills.length === 0) return {};
  const byId = new Map(skills.map((skill) => [skill.id, skill]));

  return {
    read_skill: tool({
      description: TOOL_DESCRIPTIONS.read_skill,
      inputSchema: z.object({
        id: z.string().min(1).max(200).describe("Stable id from the enabled-skills list in the system prompt."),
      }),
      execute: async ({ id }) => {
        const skill = byId.get(id);
        if (!skill) return "Skill is unavailable or disabled.";
        await options.onUsed?.(skill.id);
        return clipSkill(
          `# Skill: ${skill.name}\n\n${skill.content}`,
          options.maxOutputChars ?? 12_000,
        );
      },
    }),
  };
}
