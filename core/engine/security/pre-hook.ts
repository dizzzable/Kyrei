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

/** Built-in secret-scan gate: blocks writing content that contains secrets. */
export const secretScanHook: PreHook = ({ tool, args }) => {
  if ((tool === "write_file" || tool === "edit_file") && args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const text = String(a["content"] ?? a["patch"] ?? "");
    if (containsSecret(text)) {
      return { allow: false, reason: "Обнаружен секрет в записываемом содержимом — запись заблокирована." };
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
