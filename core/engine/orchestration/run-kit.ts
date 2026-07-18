/**
 * Namespaced long-horizon run kit (Wave A / Supergoal-shaped).
 *
 * Layout:
 *   .kyrei/run/<runId>/ROADMAP.md
 *   .kyrei/run/<runId>/STATE.json
 *   .kyrei/run/<runId>/PROTOCOL.md
 *   .kyrei/run/<runId>/phases/phase-N.md
 *   .kyrei/run/<runId>/phases/phase-N.fix.md  (optional escalate)
 *
 * Legacy single-plan store remains in plan.ts (`.kyrei/plan/`).
 */

import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { PlanPhase } from "./plan.js";

export type RunStatus =
  | "planning"
  | "running"
  | "blocked"
  | "auditing"
  | "complete"
  | "handed_off";

export type RunStrike = 0 | 1 | 2 | 3;

export interface RunState {
  runId: string;
  roadmapId: string;
  currentPhase: number;
  status: RunStatus;
  /** Consecutive failure escalations for the current phase (0–3). */
  strike: RunStrike;
  /** Optional git HEAD or other baseline marker for final audit. */
  baselineRef?: string;
  auditRound: number;
  updatedAt: string;
  lastFailure?: string;
}

export interface PhaseVerifyRow {
  criterion: string;
  pass: boolean;
  evidence?: string;
}

/** Transcript markers for goal-verify / humans (stable, grep-friendly). */
export const RUN_MARKERS = Object.freeze({
  phaseStart: (n: number) => `KYREI_PHASE_START phase=${n}`,
  phaseVerify: "KYREI_PHASE_VERIFY",
  phaseDone: (n: number) => `KYREI_PHASE_DONE phase=${n}`,
  failureProbe: "KYREI_FAILURE_PROBE",
  failureEscalate: "KYREI_FAILURE_ESCALATE",
  failureHandoff: "KYREI_FAILURE_HANDOFF",
  finalAudit: "KYREI_FINAL_AUDIT",
  auditComplete: "KYREI_AUDIT_COMPLETE",
  runComplete: "KYREI_RUN_COMPLETE",
});

export function claimRunId(slug = "run"): string {
  const safe = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "run";
  const id = randomBytes(3).toString("hex");
  return `${safe}-${id}`;
}

export function formatPhaseVerifyTable(rows: PhaseVerifyRow[]): string {
  const lines = [
    RUN_MARKERS.phaseVerify,
    "| criterion | pass | evidence |",
    "|---|---|---|",
    ...rows.map((row) => {
      const crit = row.criterion.replace(/\|/g, "/").slice(0, 120);
      const evidence = (row.evidence ?? "").replace(/\|/g, "/").slice(0, 160);
      return `| ${crit} | ${row.pass ? "yes" : "no"} | ${evidence || "—"} |`;
    }),
  ];
  return lines.join("\n");
}

export function defaultPhaseTemplate(n: number, title: string, endState: string): string {
  return [
    `# Phase ${n}: ${title}`,
    "",
    "## End state (falsifiable)",
    endState,
    "",
    "## Deliverables",
    "- [ ] …",
    "",
    "## Mandatory commands (run and paste evidence)",
    "```",
    "npm run gate   # or project equivalent",
    "```",
    "",
    "## Steps",
    "1. …",
    "",
    "## Acceptance criteria",
    "- [ ] …",
    "",
    "## Notes / blockers",
    "",
  ].join("\n");
}

export function protocolMarkdown(): string {
  return [
    "# Kyrei run PROTOCOL",
    "",
    "1. Read ROADMAP + STATE + current phase file.",
    "2. Print `" + RUN_MARKERS.phaseStart(0).replace("phase=0", "phase=N") + "`.",
    "3. Do the work with tools; keep changes surgical.",
    "4. Print a `" + RUN_MARKERS.phaseVerify + "` table with pass/fail + evidence.",
    "5. On failure: strike 1 probe → strike 2 fix note → strike 3 clean recovery checkpoint; the engine continues the task automatically.",
    "6. Print `" + RUN_MARKERS.phaseDone(0).replace("phase=0", "phase=N") + "` only when verify is green.",
    "7. After last phase: `" + RUN_MARKERS.finalAudit + "` then `" + RUN_MARKERS.runComplete + "`.",
    "",
  ].join("\n");
}

export function createRunStore(workspace: string, runId: string) {
  const safeId = runId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
  if (!safeId) throw new Error("run_id_invalid");
  const root = join(workspace, ".kyrei", "run", safeId);
  const roadmapPath = join(root, "ROADMAP.md");
  const statePath = join(root, "STATE.json");
  const protocolPath = join(root, "PROTOCOL.md");
  const phasesDir = join(root, "phases");
  const phasePath = (n: number) => join(phasesDir, `phase-${n}.md`);
  const fixPath = (n: number) => join(phasesDir, `phase-${n}.fix.md`);

  async function writeText(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  return {
    runId: safeId,
    root,

    async ensure(): Promise<void> {
      await mkdir(phasesDir, { recursive: true });
      try {
        await readFile(protocolPath, "utf8");
      } catch {
        await writeText(protocolPath, protocolMarkdown());
      }
    },

    async writeRoadmap(phases: PlanPhase[]): Promise<void> {
      await this.ensure();
      const md = [
        `# ROADMAP — ${safeId}`,
        "",
        ...phases.map(
          (p) =>
            `## Phase ${p.n}: ${p.title}\n- status: ${p.status}\n- end-state: ${p.endState}`,
        ),
        "",
      ].join("\n");
      await writeText(roadmapPath, md);
    },

    async readRoadmap(): Promise<string> {
      try {
        return await readFile(roadmapPath, "utf8");
      } catch {
        return "";
      }
    },

    async writeState(state: RunState): Promise<void> {
      await this.ensure();
      const payload: RunState = {
        ...state,
        runId: safeId,
        strike: Math.max(0, Math.min(3, Math.floor(state.strike))) as RunStrike,
        auditRound: Math.max(0, Math.floor(state.auditRound)),
        updatedAt: state.updatedAt || new Date().toISOString(),
      };
      await writeText(statePath, JSON.stringify(payload, null, 2));
    },

    async readState(): Promise<RunState | null> {
      try {
        const raw = JSON.parse(await readFile(statePath, "utf8")) as Partial<RunState>;
        if (!raw || typeof raw !== "object") return null;
        return {
          runId: safeId,
          roadmapId: typeof raw.roadmapId === "string" ? raw.roadmapId : safeId,
          currentPhase: Number.isFinite(Number(raw.currentPhase)) ? Math.max(1, Math.floor(Number(raw.currentPhase))) : 1,
          status: (raw.status as RunStatus) || "planning",
          strike: (Math.max(0, Math.min(3, Math.floor(Number(raw.strike) || 0))) as RunStrike),
          ...(typeof raw.baselineRef === "string" ? { baselineRef: raw.baselineRef } : {}),
          auditRound: Math.max(0, Math.floor(Number(raw.auditRound) || 0)),
          updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
          ...(typeof raw.lastFailure === "string" ? { lastFailure: raw.lastFailure } : {}),
        };
      } catch {
        return null;
      }
    },

    async writePhase(n: number, content: string): Promise<void> {
      await this.ensure();
      await writeText(phasePath(n), content);
    },

    async readPhase(n: number): Promise<string> {
      try {
        return await readFile(phasePath(n), "utf8");
      } catch {
        return "";
      }
    },

    async writeFixSpec(n: number, content: string): Promise<void> {
      await this.ensure();
      await writeText(fixPath(n), content);
    },

    async readFixSpec(n: number): Promise<string> {
      try {
        return await readFile(fixPath(n), "utf8");
      } catch {
        return "";
      }
    },

    async listPhaseFiles(): Promise<string[]> {
      try {
        const names = await readdir(phasesDir);
        return names.filter((name) => /^phase-\d+(\.fix)?\.md$/.test(name)).sort();
      } catch {
        return [];
      }
    },
  };
}

export type RunStore = ReturnType<typeof createRunStore>;
