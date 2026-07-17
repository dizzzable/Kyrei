/**
 * Wave D3 — long-task plan gate helpers.
 */

import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { lastUserTextFromMessages, userAuthorizedBuild } from "./goal-skim.js";
import { classifyIntent } from "./intent-router.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True when a plan artifact already exists under .kyrei/plan or .kyrei/run. */
export async function planArtifactExists(workspace: string): Promise<boolean> {
  const candidates = [
    join(workspace, ".kyrei", "plan", "ROADMAP.md"),
    join(workspace, ".kyrei", "plan", "STATE.json"),
  ];
  for (const p of candidates) {
    if (await exists(p)) {
      try {
        const body = await readFile(p, "utf8");
        if (body.trim().length >= 40) return true;
      } catch {
        /* continue */
      }
    }
  }
  try {
    const runRoot = join(workspace, ".kyrei", "run");
    if (!(await exists(runRoot))) return false;
    const entries = await readdir(runRoot, { withFileTypes: true });
    for (const e of entries.slice(0, 20)) {
      if (!e.isDirectory()) continue;
      const roadmap = join(runRoot, e.name, "ROADMAP.md");
      if (await exists(roadmap)) {
        const body = await readFile(roadmap, "utf8");
        if (body.trim().length >= 40) return true;
      }
    }
  } catch {
    /* fail-open: treat as no plan */
  }
  return false;
}

export async function shouldForcePlanMode(opts: {
  codingMode: string;
  longTaskPlanGate: boolean;
  workspace?: string;
  messages?: ReadonlyArray<{ role?: string; content?: unknown }>;
  goal?: string;
}): Promise<boolean> {
  if (!opts.longTaskPlanGate) return false;
  if (opts.codingMode !== "auto") return false;
  const text = (opts.goal ?? lastUserTextFromMessages(opts.messages ?? [])).trim();
  const intent = classifyIntent(text);
  if (!intent.forcePlan) return false;
  if (userAuthorizedBuild(text)) return false;
  for (let i = (opts.messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = opts.messages?.[i];
    if (m?.role !== "user") continue;
    const t = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p) => (typeof p === "string" ? p : (p as { text?: string }).text ?? "")).join("\n")
        : "";
    if (userAuthorizedBuild(t)) return false;
    break;
  }
  if (opts.workspace && await planArtifactExists(opts.workspace)) return false;
  return true;
}
