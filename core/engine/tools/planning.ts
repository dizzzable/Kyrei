/**
 * Plan-as-files tools (Requirements §11.4). Exposed only when
 * `planning.enabled` so long-horizon ROADMAP/STATE/phase notes survive
 * context resets and are model-writable without shell hacks.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createPlanStore, type PlanPhase, type PlanState } from "../orchestration/plan.js";
import { TOOL_DESCRIPTIONS } from "../prompt/tool-descriptions.js";

const PhaseStatusSchema = z.enum(["pending", "in_progress", "done", "blocked"]);

export interface PlanningToolOptions {
  workspace: string;
  maxModelOutputChars?: number;
  /** Refresh rebuildable memory index after plan writes. */
  onMemoryMutated?: () => void;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [вывод обрезан, ${text.length} символов]`;
}

export function buildPlanningTools(options: PlanningToolOptions): ToolSet {
  const plan = createPlanStore(options.workspace);
  const max = options.maxModelOutputChars ?? 12_000;

  return {
    plan_read: tool({
      description: TOOL_DESCRIPTIONS.plan_read,
      inputSchema: z.object({
        phase: z.number().int().min(1).max(100).optional().describe("Optional phase number; omit to load roadmap + state only."),
      }),
      execute: async ({ phase }) => {
        try {
          const roadmap = await plan.readRoadmap();
          const state = await plan.readState();
          const parts: string[] = [];
          if (roadmap.trim()) parts.push(roadmap.trim());
          else parts.push("(no ROADMAP.md yet)");
          if (state) {
            parts.push(
              [
                "STATE:",
                `- roadmapId: ${state.roadmapId}`,
                `- currentPhase: ${state.currentPhase}`,
                `- updatedAt: ${state.updatedAt}`,
              ].join("\n"),
            );
          } else {
            parts.push("(no STATE.json yet)");
          }
          const phaseN = phase ?? state?.currentPhase;
          if (phaseN != null) {
            const body = await plan.readPhase(phaseN);
            parts.push(body.trim() ? `## Phase ${phaseN} notes\n${body.trim()}` : `(no phase-${phaseN}.md yet)`);
          }
          return clip(parts.join("\n\n"), max);
        } catch (error) {
          return `Failed to read plan: ${(error as Error).message}`;
        }
      },
    }),

    plan_write_roadmap: tool({
      description: TOOL_DESCRIPTIONS.plan_write_roadmap,
      inputSchema: z.object({
        phases: z
          .array(
            z.object({
              n: z.number().int().min(1).max(100),
              title: z.string().min(1).max(200),
              status: PhaseStatusSchema,
              endState: z.string().min(1).max(500),
            }),
          )
          .min(1)
          .max(40),
      }),
      execute: async ({ phases }) => {
        try {
          const ordered = [...phases].sort((a, b) => a.n - b.n) as PlanPhase[];
          await plan.writeRoadmap(ordered);
          options.onMemoryMutated?.();
          return `Wrote ROADMAP with ${ordered.length} phase(s).`;
        } catch (error) {
          return `Failed to write roadmap: ${(error as Error).message}`;
        }
      },
    }),

    plan_write_state: tool({
      description: TOOL_DESCRIPTIONS.plan_write_state,
      inputSchema: z.object({
        roadmapId: z.string().min(1).max(120).describe("Stable id for this roadmap (e.g. 'feature-x')."),
        currentPhase: z.number().int().min(1).max(100),
      }),
      execute: async ({ roadmapId, currentPhase }) => {
        try {
          const state: PlanState = {
            roadmapId,
            currentPhase,
            updatedAt: new Date().toISOString(),
          };
          await plan.writeState(state);
          options.onMemoryMutated?.();
          return `Plan state updated: phase ${currentPhase} (roadmap ${roadmapId}).`;
        } catch (error) {
          return `Failed to write plan state: ${(error as Error).message}`;
        }
      },
    }),

    plan_write_phase: tool({
      description: TOOL_DESCRIPTIONS.plan_write_phase,
      inputSchema: z.object({
        n: z.number().int().min(1).max(100),
        content: z.string().min(1).max(50_000).describe("Markdown notes for this phase (steps, blockers, outcomes)."),
      }),
      execute: async ({ n, content }) => {
        try {
          await plan.writePhase(n, content);
          options.onMemoryMutated?.();
          return `Wrote phase-${n}.md (${content.length} chars).`;
        } catch (error) {
          return `Failed to write phase: ${(error as Error).message}`;
        }
      },
    }),
  };
}
