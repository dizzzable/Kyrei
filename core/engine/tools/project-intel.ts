/** Deterministic project-graph tools backed by workspace-local `.kyrei/intel`. */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  analyzeProjectImpact,
  buildProjectIndexIncremental,
  formatProjectImpact,
  formatProjectIndex,
  loadProjectIndex,
  persistProjectIndex,
} from "../intel/project-index.js";
import { TOOL_DESCRIPTIONS } from "../prompt/tool-descriptions.js";

export function buildProjectIntelTools(
  workspace: string,
  options: {
    onMemoryMutated?: () => void;
    /** Awaitable flush so graph-lite is searchable before the tool returns. */
    flushMemoryIndex?: () => Promise<void>;
  } = {},
): ToolSet {
  return {
    project_index: tool({
      description: TOOL_DESCRIPTIONS.project_index,
      inputSchema: z.object({}),
      execute: async () => {
        try {
          // Try incremental SQLite-backed indexing first (Phase 3C)
          const index = await buildProjectIndexIncremental(workspace);
          await persistProjectIndex(workspace, index);
          // Prefer awaited flush so Settings/search see graph-lite immediately (OOB).
          if (options.flushMemoryIndex) {
            await options.flushMemoryIndex();
          } else {
            options.onMemoryMutated?.();
          }
          return `${formatProjectIndex(index, { edgeLimit: 80 })}\n\nSaved under .kyrei/intel/ for subsequent reads.`;
        } catch (err) {
          return `Indexing failed: ${err instanceof Error ? err.message : String(err)}`;
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
