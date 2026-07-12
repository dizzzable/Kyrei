/**
 * Layered instruction/memory assembly with precedence (Requirements §6.2, §6.5).
 * Order (high → low): AGENTS.md → steering (.kiro/steering/*.md, always) →
 * project MEMORY.md → global GLOBAL.md. Higher layers win; each block is labeled.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

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
}

export async function assembleSystemContext(opts: AssembleOpts): Promise<string> {
  const { workspace } = opts;
  const layers: Array<{ name: string; body: string }> = [];
  const agents = await readIfExists(join(workspace, "AGENTS.md"));
  if (agents) layers.push({ name: "AGENTS.md", body: agents });
  for (const s of await readAlwaysSteering(workspace)) layers.push({ name: "steering", body: s });
  const mem = await readIfExists(join(workspace, ".kyrei", "memory", "MEMORY.md"));
  if (mem) layers.push({ name: "MEMORY.md", body: mem });
  if (opts.globalDir) {
    const g = await readIfExists(join(opts.globalDir, "GLOBAL.md"));
    if (g) layers.push({ name: "GLOBAL.md", body: g });
  }
  return layers.map((l) => `<<layer:${l.name}>>\n${l.body.trim()}`).join("\n\n");
}
