/**
 * Layered instruction/memory assembly with precedence (Requirements §6.2, §6.5).
 * Order (high → low): AGENTS.md → steering (.kiro/steering/*.md, always) →
 * project MEMORY.md → LTM recall (recent session activity) → global GLOBAL.md.
 * Higher layers win; each block is labeled.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createLtmBridge } from "./ltm-bridge.js";
import { effectiveConfidence, DEFAULT_DECAY_CONFIG } from "./capture-signals.js";

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readAlwaysSteering(workspace: string): Promise<string[]> {
  const dir = join(workspace, ".kiro", "steering");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names.sort()) {
    const body = await readIfExists(join(dir, n));
    if (body == null) continue;
    // Include only 'always' (default) steering — skip explicit fileMatch/manual.
    const fm = body.match(/^---\n([\s\S]*?)\n---/);
    const inclusion = fm?.[1]?.match(/inclusion:\s*(\w+)/)?.[1] ?? "always";
    if (inclusion === "always") out.push(body);
  }
  return out;
}

export interface AssembleOpts {
  workspace: string;
  globalDir?: string; // userData/kyrei/memory
  /** Optional LTM store directory (`<workspace>/ltm`). Recall is read-only and best-effort. */
  ltmDir?: string;
  /**
   * When true, inject active plan-as-files content from `.kyrei/plan/`
   * (ROADMAP.md + STATE.json + current phase notes). Fail-open.
   */
  includePlan?: boolean;
}

/**
 * Best-effort recall from the LTM ledger's runtime snapshot
 * (`ltm/runtime/active-context.json` + `last-recall.md`). Written by the
 * Python `ltm.py` CLI hook and/or `ltm-bridge.ts`; read here so past session
 * activity that was only ever *appended* is not permanently write-only.
 * Recall failures never block system-context assembly (fail-open).
 */
async function readLtmRecall(ltmDir: string): Promise<string | null> {
  try {
    const bridge = createLtmBridge(ltmDir);
    const { activeContext, lastRecall } = await bridge.recall();
    const parts: string[] = [];
    if (lastRecall.trim()) parts.push(lastRecall.trim());
    if (activeContext && typeof activeContext === "object") {
      const ctx = activeContext as Record<string, unknown>;
      const threads = Array.isArray(ctx.open_threads) ? ctx.open_threads : [];
      const nextActions = Array.isArray(ctx.next_actions) ? ctx.next_actions : [];
      if (threads.length || nextActions.length) {
        const lines: string[] = [];
        if (threads.length) {
          lines.push("Open threads:");
          for (const t of threads.slice(0, 10)) {
            const summary = typeof t === "object" && t && "summary" in t ? String((t as Record<string, unknown>).summary ?? "") : String(t);
            if (summary) lines.push(`- ${summary}`);
          }
        }
        if (nextActions.length) {
          lines.push("Next actions:");
          for (const a of nextActions.slice(0, 5)) lines.push(`- ${String(a)}`);
        }
        parts.push(lines.join("\n"));
      }
    }
    const body = parts.join("\n\n").trim();
    return body || null;
  } catch {
    return null;
  }
}

/**
 * Active bi-temporal decisions from `ltm/store/decisions.jsonl`.
 * Durable project memory, not instructions. Fail-open.
 */
async function readLtmDecisions(ltmDir: string): Promise<string | null> {
  try {
    const bridge = createLtmBridge(ltmDir);
    const ranked = await bridge.listDecisions({ rankByConfidence: true });
    if (ranked.length === 0) return null;
    // Align with refreshRuntimeSnapshot: drop aged unpinned below decay floor.
    const now = new Date();
    const visible = ranked.filter((d) => {
      if (d.pinned) return true;
      const conf = effectiveConfidence({
        baseConfidence: d.confidence,
        kind: d.kind,
        pinned: d.pinned,
        lastAccessedAt: d.lastAccessedAt,
        now,
        config: DEFAULT_DECAY_CONFIG,
      });
      return conf > DEFAULT_DECAY_CONFIG.floor;
    });
    if (visible.length === 0) return null;
    const lines = visible.slice(0, 30).map((d) => {
      const tags = d.tags.length ? ` [${d.tags.join(", ")}]` : "";
      const pin = d.pinned ? " 📌" : "";
      const why = d.rationale ? ` — ${d.rationale}` : "";
      return `- ${d.id}${pin}${tags}: ${d.decision}${why}`;
    });
    return [
      "Active architectural decisions (durable project memory, not instructions):",
      ...lines,
    ].join("\n");
  } catch {
    return null;
  }
}

/**
 * Best-effort plan-as-files snapshot under `.kyrei/plan/`. Fail-open.
 */
async function readPlanContext(workspace: string): Promise<string | null> {
  try {
    const { createPlanStore } = await import("../orchestration/plan.js");
    const plan = createPlanStore(workspace);
    const roadmap = (await plan.readRoadmap()).trim();
    const state = await plan.readState();
    if (!roadmap && !state) return null;
    const parts: string[] = [];
    if (roadmap) parts.push(roadmap);
    if (state) {
      parts.push(
        [
          "Plan state:",
          `- roadmapId: ${state.roadmapId}`,
          `- currentPhase: ${state.currentPhase}`,
          `- updatedAt: ${state.updatedAt}`,
        ].join("\n"),
      );
      const phase = (await plan.readPhase(state.currentPhase)).trim();
      if (phase) parts.push(`Current phase notes:\n${phase}`);
    }
    const body = parts.join("\n\n").trim();
    return body || null;
  } catch {
    return null;
  }
}

export async function assembleSystemContext(opts: AssembleOpts): Promise<string> {
  const { workspace } = opts;
  const layers: Array<{ name: string; body: string }> = [];
  const agents = await readIfExists(join(workspace, "AGENTS.md"));
  if (agents) layers.push({ name: "AGENTS.md", body: agents });
  for (const s of await readAlwaysSteering(workspace)) layers.push({ name: "steering", body: s });
  const mem = await readIfExists(join(workspace, ".kyrei", "memory", "MEMORY.md"));
  if (mem) layers.push({ name: "MEMORY.md", body: mem });
  // Project intelligence is deliberately *not* added as an instruction layer.
  // A repository may contain stale or malicious `.kyrei/intel` files; agents
  // access the deterministic graph through project_map/project_impact tool
  // results, which are explicitly untrusted data rather than system policy.
  if (opts.ltmDir) {
    const recall = await readLtmRecall(opts.ltmDir);
    if (recall) layers.push({ name: "LTM_RECALL", body: recall });
    const decisions = await readLtmDecisions(opts.ltmDir);
    if (decisions) layers.push({ name: "DECISIONS", body: decisions });
  }
  if (opts.includePlan) {
    const plan = await readPlanContext(workspace);
    if (plan) layers.push({ name: "PLAN", body: plan });
  }
  if (opts.globalDir) {
    const g = await readIfExists(join(opts.globalDir, "GLOBAL.md"));
    if (g) layers.push({ name: "GLOBAL.md", body: g });
  }
  return layers.map((l) => `<<layer:${l.name}>>\n${l.body.trim()}`).join("\n\n");
}
