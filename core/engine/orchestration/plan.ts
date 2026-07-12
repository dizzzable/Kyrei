/**
 * Plan-as-files (Requirements §11.4). Long-horizon plans live as markdown/JSON
 * files under `.kyrei/plan/` (ROADMAP/STATE/phase-N), so work survives window
 * resets and is resumable. Adaptive phase count (not fixed).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export interface PlanPhase {
  n: number;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  endState: string;
}
export interface PlanState {
  roadmapId: string;
  currentPhase: number;
  updatedAt: string;
}

export function createPlanStore(workspace: string) {
  const dir = join(workspace, ".kyrei", "plan");
  const roadmapPath = join(dir, "ROADMAP.md");
  const statePath = join(dir, "STATE.json");
  const phasePath = (n: number) => join(dir, `phase-${n}.md`);

  async function writeText(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }

  return {
    async writeRoadmap(phases: PlanPhase[]): Promise<void> {
      const md = [
        "# ROADMAP",
        "",
        ...phases.map((p) => `## Phase ${p.n}: ${p.title}\n- status: ${p.status}\n- end-state: ${p.endState}`),
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
    async writeState(state: PlanState): Promise<void> {
      await writeText(statePath, JSON.stringify(state, null, 2));
    },
    async readState(): Promise<PlanState | null> {
      try {
        return JSON.parse(await readFile(statePath, "utf8")) as PlanState;
      } catch {
        return null;
      }
    },
    async writePhase(n: number, content: string): Promise<void> {
      await writeText(phasePath(n), content);
    },
    async readPhase(n: number): Promise<string> {
      try {
        return await readFile(phasePath(n), "utf8");
      } catch {
        return "";
      }
    },
  };
}
