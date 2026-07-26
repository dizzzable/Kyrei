/**
 * Pre-tool-use gate (Requirements §8.7). Runs before a tool executes; can block
 * the call or scan for secrets. Fail-closed on a thrown hook error is opt-in.
 */

import { containsSecret } from "./secrets.js";

export interface PreHookContext {
  tool: string;
  args: unknown;
}
export interface PreHookResult {
  allow: boolean;
  reason?: string;
}
export type PreHook = (ctx: PreHookContext) => Promise<PreHookResult> | PreHookResult;

/**
 * Tools whose content is scanned for secrets before it is written.
 *
 * The memory writers were absent, so a model could write an API key straight
 * into durable `MEMORY.md` unscanned — and that file is read back into the
 * system prompt on every later turn. Their argument is also `content`, so no
 * extra extraction is needed.
 */
const SECRET_SCANNED_TOOLS = new Set([
  "write_file",
  "edit_file",
  "memory_write_project",
  "memory_write_notes",
  "memory_write_global",
]);

/** Built-in secret-scan gate: blocks writing content that contains secrets. */
export const secretScanHook: PreHook = ({ tool, args }) => {
  if (SECRET_SCANNED_TOOLS.has(tool) && args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const text = String(a["content"] ?? a["patch"] ?? "");
    if (containsSecret(text)) {
      return { allow: false, reason: "A secret was detected in the content being written — the write was blocked." };
    }
  }
  return { allow: true };
};

export async function runPreHooks(hooks: PreHook[], ctx: PreHookContext, failClosed = false): Promise<PreHookResult> {
  for (const hook of hooks) {
    try {
      const r = await hook(ctx);
      if (!r.allow) return r;
    } catch (e) {
      if (failClosed) return { allow: false, reason: `pre-hook error: ${(e as Error).message}` };
    }
  }
  return { allow: true };
}
