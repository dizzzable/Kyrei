/**
 * Evidence-gated verification (Phase 4). Requirements §9.5.
 * Ecosystem auto-detect (pure, from a file list) + runner (spawn).
 */

import { spawn } from "node:child_process";

export interface VerifyCommand {
  ecosystem: string;
  command: string;
}

/** Detect verify commands from the set of marker files present in the workspace root. */
export function detectEcosystem(rootFiles: string[]): VerifyCommand[] {
  const has = (name: string) => rootFiles.includes(name);
  const cmds: VerifyCommand[] = [];
  if (has("package.json")) cmds.push({ ecosystem: "node", command: "npm test --silent" });
  if (has("tsconfig.json")) cmds.push({ ecosystem: "typescript", command: "npx tsc --noEmit" });
  if (has("pyproject.toml") || has("ruff.toml")) cmds.push({ ecosystem: "python", command: "ruff check ." });
  if (has("Cargo.toml")) cmds.push({ ecosystem: "rust", command: "cargo check --message-format=short" });
  if (has("go.mod")) cmds.push({ ecosystem: "go", command: "go build ./..." });
  return cmds;
}

export interface VerifyResult {
  command: string;
  ok: boolean;
  output: string;
}

export function runVerify(command: string, cwd: string, timeoutMs = 120_000): Promise<VerifyResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({ command, ok: false, output: `spawn error: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ command, ok: code === 0, output: out.slice(0, 8000) });
    });
  });
}
