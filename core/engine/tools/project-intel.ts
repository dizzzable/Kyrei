/** Deterministic project-graph tools backed by workspace-local `.kyrei/intel`. */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  analyzeProjectImpact,
  buildProjectIndex,
  formatProjectImpact,
  formatProjectIndex,
  loadProjectIndex,
  persistProjectIndex,
} from "../intel/project-index.js";
import { TOOL_DESCRIPTIONS } from "../prompt/tool-descriptions.js";

export function buildProjectIntelTools(workspace: string): ToolSet {
  return {
    project_index: tool({
      description: TOOL_DESCRIPTIONS.project_index,
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const index = await buildProjectIndex(workspace);
          await persistProjectIndex(workspace, index);
          return `${formatProjectIndex(index, { edgeLimit: 80 })}\n\nSaved under .kyrei/intel/ for future turns.`;
        } catch (error) {
          return `Project indexing failed: ${(error as Error).message}`;
        }
      },
    }),
    project_map: tool({
      description: TOOL_DESCRIPTIONS.project_map,
      inputSchema: z.object({}),
      execute: async () => {
        const index = await loadProjectIndex(workspace);
        return index
          ? formatProjectIndex(index)
          : "No project index exists yet. Run project_index before requesting the map.";
      },
    }),
    project_impact: tool({
      description: TOOL_DESCRIPTIONS.project_impact,
      inputSchema: z.object({
        path: z.string().min(1).describe("Workspace-relative file path to analyze."),
        depth: z.number().int().min(1).max(6).optional(),
      }),
      execute: async ({ path, depth }) => {
        const index = await loadProjectIndex(workspace);
        if (!index) return "No project index exists yet. Run project_index before impact analysis.";
        return formatProjectImpact(analyzeProjectImpact(index, path, depth));
      },
    }),
  };
}
