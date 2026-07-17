/**
 * Plan-as-files tools (Requirements §11.4) + Wave A run kit.
 *
 * - Legacy single plan: `.kyrei/plan/` (plan_* tools)
 * - Namespaced long-horizon runs: `.kyrei/run/<id>/` (run_* tools)
 *
 * Exposed only when `planning.enabled` so ROADMAP/STATE/phase notes survive
 * context resets and are model-writable without shell hacks.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { createPlanStore, type PlanPhase, type PlanState } from "../orchestration/plan.js";
import {
  claimRunId,
  createRunStore,
  defaultPhaseTemplate,
  formatPhaseVerifyTable,
  type RunState,
  type RunStatus,
  type RunStrike,
} from "../orchestration/run-kit.js";
import { evaluateFinalAudit } from "../reliability/final-audit.js";
import { TOOL_DESCRIPTIONS } from "../prompt/tool-descriptions.js";

const PhaseStatusSchema = z.enum(["pending", "in_progress", "done", "blocked"]);
const RunStatusSchema = z.enum([
  "planning",
  "running",
  "blocked",
  "auditing",
  "complete",
  "handed_off",
]);

const PhaseRowSchema = z.object({
  n: z.number().int().min(1).max(100),
  title: z.string().min(1).max(200),
  status: PhaseStatusSchema,
  endState: z.string().min(1).max(500),
});

const VerifyRowSchema = z.object({
  criterion: z.string().min(1).max(200),
  pass: z.boolean(),
  evidence: z.string().max(400).optional(),
});

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

function asRunStrike(n: number): RunStrike {
  return Math.max(0, Math.min(3, Math.floor(n))) as RunStrike;
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
        phases: z.array(PhaseRowSchema).min(1).max(40),
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

    // ── Wave A run kit (`.kyrei/run/<id>/`) ────────────────────────────

    run_claim: tool({
      description: TOOL_DESCRIPTIONS.run_claim,
      inputSchema: z.object({
        slug: z.string().min(1).max(40).optional().describe("Short slug for the run id (e.g. 'auth-fix')."),
        phases: z
          .array(PhaseRowSchema)
          .min(1)
          .max(40)
          .optional()
          .describe("Optional initial phases; writes ROADMAP + phase stubs."),
      }),
      execute: async ({ slug, phases }) => {
        try {
          const runId = claimRunId(slug ?? "run");
          const store = createRunStore(options.workspace, runId);
          await store.ensure();
          if (phases?.length) {
            const ordered = [...phases].sort((a, b) => a.n - b.n) as PlanPhase[];
            await store.writeRoadmap(ordered);
            for (const p of ordered) {
              await store.writePhase(p.n, defaultPhaseTemplate(p.n, p.title, p.endState));
            }
            await store.writeState({
              runId,
              roadmapId: runId,
              currentPhase: ordered[0]!.n,
              status: "planning",
              strike: 0,
              auditRound: 0,
              updatedAt: new Date().toISOString(),
            });
          } else {
            await store.writeState({
              runId,
              roadmapId: runId,
              currentPhase: 1,
              status: "planning",
              strike: 0,
              auditRound: 0,
              updatedAt: new Date().toISOString(),
            });
          }
          options.onMemoryMutated?.();
          return [
            `Claimed run ${runId}`,
            `root: .kyrei/run/${runId}/`,
            phases?.length ? `phases: ${phases.length}` : "phases: (none yet — use run_write_roadmap)",
          ].join("\n");
        } catch (error) {
          return `Failed to claim run: ${(error as Error).message}`;
        }
      },
    }),

    run_read: tool({
      description: TOOL_DESCRIPTIONS.run_read,
      inputSchema: z.object({
        runId: z.string().min(1).max(80),
        phase: z.number().int().min(1).max(100).optional(),
        includeFix: z.boolean().optional().describe("Also load phase-N.fix.md if present."),
      }),
      execute: async ({ runId, phase, includeFix }) => {
        try {
          const store = createRunStore(options.workspace, runId);
          const roadmap = await store.readRoadmap();
          const state = await store.readState();
          const parts: string[] = [`runId: ${store.runId}`];
          if (roadmap.trim()) parts.push(roadmap.trim());
          else parts.push("(no ROADMAP.md yet)");
          if (state) {
            parts.push(
              [
                "STATE:",
                `- status: ${state.status}`,
                `- currentPhase: ${state.currentPhase}`,
                `- strike: ${state.strike}`,
                `- auditRound: ${state.auditRound}`,
                `- updatedAt: ${state.updatedAt}`,
                ...(state.lastFailure ? [`- lastFailure: ${state.lastFailure}`] : []),
              ].join("\n"),
            );
          } else {
            parts.push("(no STATE.json yet)");
          }
          const phaseN = phase ?? state?.currentPhase;
          if (phaseN != null) {
            const body = await store.readPhase(phaseN);
            parts.push(body.trim() ? `## Phase ${phaseN}\n${body.trim()}` : `(no phase-${phaseN}.md yet)`);
            if (includeFix) {
              const fix = await store.readFixSpec(phaseN);
              if (fix.trim()) parts.push(`## Phase ${phaseN} fix\n${fix.trim()}`);
            }
          }
          const files = await store.listPhaseFiles();
          if (files.length) parts.push(`phase files: ${files.join(", ")}`);
          return clip(parts.join("\n\n"), max);
        } catch (error) {
          return `Failed to read run: ${(error as Error).message}`;
        }
      },
    }),

    run_write_roadmap: tool({
      description: TOOL_DESCRIPTIONS.run_write_roadmap,
      inputSchema: z.object({
        runId: z.string().min(1).max(80),
        phases: z.array(PhaseRowSchema).min(1).max(40),
        seedPhaseFiles: z
          .boolean()
          .optional()
          .describe("If true, write default phase-N.md stubs when missing."),
      }),
      execute: async ({ runId, phases, seedPhaseFiles }) => {
        try {
          const store = createRunStore(options.workspace, runId);
          const ordered = [...phases].sort((a, b) => a.n - b.n) as PlanPhase[];
          await store.writeRoadmap(ordered);
          if (seedPhaseFiles) {
            for (const p of ordered) {
              const existing = await store.readPhase(p.n);
              if (!existing.trim()) {
                await store.writePhase(p.n, defaultPhaseTemplate(p.n, p.title, p.endState));
              }
            }
          }
          options.onMemoryMutated?.();
          return `Wrote run ${store.runId} ROADMAP with ${ordered.length} phase(s).`;
        } catch (error) {
          return `Failed to write run roadmap: ${(error as Error).message}`;
        }
      },
    }),

    run_write_state: tool({
      description: TOOL_DESCRIPTIONS.run_write_state,
      inputSchema: z.object({
        runId: z.string().min(1).max(80),
        currentPhase: z.number().int().min(1).max(100),
        status: RunStatusSchema.optional(),
        strike: z.number().int().min(0).max(3).optional(),
        auditRound: z.number().int().min(0).max(20).optional(),
        lastFailure: z.string().max(500).optional(),
        baselineRef: z.string().max(120).optional(),
      }),
      execute: async ({ runId, currentPhase, status, strike, auditRound, lastFailure, baselineRef }) => {
        try {
          const store = createRunStore(options.workspace, runId);
          const prev = await store.readState();
          const next: RunState = {
            runId: store.runId,
            roadmapId: prev?.roadmapId ?? store.runId,
            currentPhase,
            status: (status as RunStatus | undefined) ?? prev?.status ?? "running",
            strike: strike != null ? asRunStrike(strike) : (prev?.strike ?? 0),
            auditRound: auditRound ?? prev?.auditRound ?? 0,
            updatedAt: new Date().toISOString(),
            ...(baselineRef !== undefined
              ? { baselineRef }
              : prev?.baselineRef
                ? { baselineRef: prev.baselineRef }
                : {}),
            ...(lastFailure !== undefined
              ? { lastFailure }
              : prev?.lastFailure
                ? { lastFailure: prev.lastFailure }
                : {}),
          };
          await store.writeState(next);
          options.onMemoryMutated?.();
          return `Run ${store.runId} state: phase ${next.currentPhase}, status ${next.status}, strike ${next.strike}.`;
        } catch (error) {
          return `Failed to write run state: ${(error as Error).message}`;
        }
      },
    }),

    run_write_phase: tool({
      description: TOOL_DESCRIPTIONS.run_write_phase,
      inputSchema: z.object({
        runId: z.string().min(1).max(80),
        n: z.number().int().min(1).max(100),
        content: z.string().min(1).max(50_000),
      }),
      execute: async ({ runId, n, content }) => {
        try {
          const store = createRunStore(options.workspace, runId);
          await store.writePhase(n, content);
          options.onMemoryMutated?.();
          return `Wrote .kyrei/run/${store.runId}/phases/phase-${n}.md (${content.length} chars).`;
        } catch (error) {
          return `Failed to write run phase: ${(error as Error).message}`;
        }
      },
    }),

    run_write_fix: tool({
      description: TOOL_DESCRIPTIONS.run_write_fix,
      inputSchema: z.object({
        runId: z.string().min(1).max(80),
        n: z.number().int().min(1).max(100),
        content: z.string().min(1).max(50_000).describe("Focused fix-spec: diagnosis, different approach, commands."),
      }),
      execute: async ({ runId, n, content }) => {
        try {
          const store = createRunStore(options.workspace, runId);
          await store.writeFixSpec(n, content);
          const prev = await store.readState();
          if (prev) {
            await store.writeState({
              ...prev,
              strike: 2,
              status: prev.status === "complete" ? prev.status : "running",
              lastFailure: content.slice(0, 200),
              updatedAt: new Date().toISOString(),
            });
          }
          options.onMemoryMutated?.();
          return [
            `Wrote phase-${n}.fix.md for run ${store.runId}.`,
            "Print KYREI_FAILURE_ESCALATE, then execute the fix approach (do not repeat the failed call).",
          ].join("\n");
        } catch (error) {
          return `Failed to write fix spec: ${(error as Error).message}`;
        }
      },
    }),

    run_phase_verify: tool({
      description: TOOL_DESCRIPTIONS.run_phase_verify,
      inputSchema: z.object({
        rows: z.array(VerifyRowSchema).min(1).max(40),
        phase: z.number().int().min(1).max(100).optional(),
      }),
      execute: async ({ rows, phase }) => {
        const table = formatPhaseVerifyTable(
          rows.map((r) => ({
            criterion: r.criterion,
            pass: r.pass,
            ...(r.evidence ? { evidence: r.evidence } : {}),
          })),
        );
        const allPass = rows.every((r) => r.pass);
        const footer = phase != null
          ? allPass
            ? `\n\nAll criteria green — print KYREI_PHASE_DONE phase=${phase} after evidence is in the transcript.`
            : `\n\nGaps remain — do not print KYREI_PHASE_DONE phase=${phase}. Escalate via 3-strike if stuck.`
          : allPass
            ? "\n\nAll criteria green — print KYREI_PHASE_DONE when ready."
            : "\n\nGaps remain — fix before phase done.";
        return clip(table + footer, max);
      },
    }),

    run_final_audit: tool({
      description: TOOL_DESCRIPTIONS.run_final_audit,
      inputSchema: z.object({
        criteria: z.array(VerifyRowSchema).max(40).default([]),
        commands: z
          .array(
            z.object({
              name: z.string().min(1).max(120),
              exitCode: z.number().int(),
              evidence: z.string().max(400).optional(),
            }),
          )
          .max(20)
          .default([]),
        deliverables: z
          .array(
            z.object({
              path: z.string().min(1).max(400),
              present: z.boolean(),
            }),
          )
          .max(40)
          .default([]),
        cleanlinessIssues: z.array(z.string().max(200)).max(20).optional(),
        trustPriorRatio: z.number().min(0).max(1).optional(),
        runId: z.string().min(1).max(80).optional().describe("If set, bump auditRound / status on the run STATE."),
      }).superRefine((val, ctx) => {
        // Fail closed: empty audit must not green-complete a run.
        if (val.criteria.length + val.commands.length + val.deliverables.length === 0) {
          ctx.addIssue({
            code: "custom",
            message: "Provide at least one criterion, command, or deliverable — empty final audit is rejected.",
          });
        }
      }),
      execute: async ({ criteria, commands, deliverables, cleanlinessIssues, trustPriorRatio, runId }) => {
        try {
          // Defense in depth: never mark run complete without evidence.
          if (criteria.length + commands.length + deliverables.length === 0) {
            return [
              "KYREI_FINAL_AUDIT",
              "coverage=0%",
              "gaps=1",
              "- no_evidence_provided: supply criteria, re-run commands, or deliverable checks",
              "KYREI_AUDIT_GAPS",
              "Empty final audit rejected — not_observed ≠ green.",
            ].join("\n");
          }
          const result = evaluateFinalAudit({
            criteria: criteria.map((r) => ({
              criterion: r.criterion,
              pass: r.pass,
              ...(r.evidence ? { evidence: r.evidence } : {}),
            })),
            commands: commands.map((c) => ({
              name: c.name,
              exitCode: c.exitCode,
              ...(c.evidence ? { evidence: c.evidence } : {}),
            })),
            deliverables,
            ...(cleanlinessIssues ? { cleanlinessIssues } : {}),
            ...(trustPriorRatio != null ? { trustPriorRatio } : {}),
          });
          if (runId) {
            const store = createRunStore(options.workspace, runId);
            const prev = await store.readState();
            if (prev) {
              await store.writeState({
                ...prev,
                auditRound: (prev.auditRound ?? 0) + 1,
                status: result.clean ? "complete" : "auditing",
                strike: result.clean ? 0 : prev.strike,
                updatedAt: new Date().toISOString(),
              });
              options.onMemoryMutated?.();
            }
          }
          return clip(result.transcriptBlock, max);
        } catch (error) {
          return `Failed final audit: ${(error as Error).message}`;
        }
      },
    }),
  };
}
