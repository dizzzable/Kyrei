/**
 * LTM consolidation. Prefer the pure-TS runtime snapshot (no Python).
 * Optional ltm.py regenerate remains for environments that ship the Python CLI.
 * Requirements §6.5.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { createLtmBridge } from "./ltm-bridge.js";

export interface ConsolidateResult {
  success: boolean;
  error?: string;
  stdout?: string;
  /** Which path produced the snapshot. */
  via?: "typescript" | "python";
}

/**
 * Regenerate LTM runtime artifacts (`ltm/runtime/active-context.json`,
 * `last-recall.md`) from the ledger. Default path is TypeScript (always on).
 * Set `preferPython: true` to try `ltm/bin/ltm.py` first and fall back to TS.
 */
export async function consolidateLtm(
  workspace: string,
  pythonCommand = "python",
  timeoutMs = 30_000,
  opts: { preferPython?: boolean; ltmDir?: string } = {},
): Promise<ConsolidateResult> {
  const ltmDir = opts.ltmDir ?? join(workspace, "ltm");
  const runTs = async (): Promise<ConsolidateResult> => {
    try {
      const bridge = createLtmBridge(ltmDir);
      await bridge.refreshRuntimeSnapshot();
      return { success: true, via: "typescript", stdout: "refreshRuntimeSnapshot" };
    } catch (error) {
      return {
        success: false,
        via: "typescript",
        error: `TS consolidate failed: ${(error as Error).message}`,
      };
    }
  };

  if (!opts.preferPython) {
    return runTs();
  }

  const ltmScript = join(workspace, "ltm", "bin", "ltm.py");
  const pyResult = await new Promise<ConsolidateResult>((resolve) => {
    const proc = spawn(pythonCommand, ["-X", "utf8", ltmScript, "regenerate"], {
      cwd: workspace,
      timeout: timeoutMs,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ success: true, via: "python", stdout: stdout.trim() });
      } else {
        resolve({
          success: false,
          via: "python",
          error: `ltm.py regenerate exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
          stdout: stdout.trim(),
        });
      }
    });
    proc.on("error", (err) => {
      resolve({ success: false, via: "python", error: `Failed to spawn ltm.py: ${err.message}` });
    });
  });

  if (pyResult.success) return pyResult;
  const ts = await runTs();
  if (ts.success) {
    return {
      ...ts,
      stdout: `python_failed_then_ts: ${pyResult.error ?? ""}; ${ts.stdout ?? ""}`.trim(),
    };
  }
  return {
    success: false,
    error: `python: ${pyResult.error ?? "failed"}; ts: ${ts.error ?? "failed"}`,
  };
}
