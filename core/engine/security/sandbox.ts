/**
 * OS-sandbox port (task 19.1, backlog / opt-in).
 *
 * Provides an OPTIONAL extra isolation layer for `run_command` on top of the
 * workspace jail + permission engine. It is OFF by default; enable via
 * EngineConfig `sandbox: "strict"` or `sandbox: "strict-required"`.
 *
 * HONEST LIMITS (documented residual risk):
 *  - The jail (safePath) already confines *tool-driven* file access. This
 *    sandbox targets the one place we hand control to the OS: shell commands
 *    spawned by run_command, which the jail cannot constrain.
 *  - We do NOT ship native sandboxing code. Strict mode is best-effort: it
 *    wraps commands with a platform primitive IF one is available on the host:
 *      · Linux  → bubblewrap (`bwrap`) (fs/namespaces + no net)
 *      · macOS  → `sandbox-exec` with a generated deny-by-default profile
 *      · Windows→ no reliable userland sandbox without a native Job Object
 *                 addon; strict mode is UNAVAILABLE and falls back to the jail
 *                 + permission engine only. This is a known residual risk.
 *  - If best-effort strict mode is requested but no primitive is available, we surface it
 *    via `available()`/`describe()`; callers keep the un-sandboxed command
 *    (fail-open) so functionality is never silently broken — the security
 *    posture is reported, not enforced by crashing.
 */

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sanitizeEnv } from "./secrets.js";

export type SandboxMode = "off" | "strict" | "strict-required";

export class SandboxUnavailableError extends Error {
  readonly code = "sandbox_required_unavailable";

  constructor(note: string) {
    super(`sandbox_required_unavailable: ${note}`);
    this.name = "SandboxUnavailableError";
  }
}

export interface WrapInput {
  /** The raw shell command the model wants to run. */
  command: string;
  /** Working directory (already jailed to the workspace). */
  cwd: string;
  /** Allow outbound network. Default false in strict mode. */
  allowNetwork?: boolean;
}

export interface Sandbox {
  /** Stable identifier of the backing primitive ("noop" | "bwrap" | ...). */
  readonly id: string;
  /** Bound at creation so strict-required cannot be downgraded by a caller. */
  readonly required?: boolean;
  /** Whether this sandbox can actually enforce isolation on this host. */
  available(): Promise<boolean>;
  /**
   * Wrap a command for isolated execution and return a shell-ready string.
   * When the sandbox is a noop (or unavailable), returns `command` unchanged.
   */
  wrap(input: WrapInput): string;
  /** Human-readable description of the effective posture (for audit/UX). */
  describe(): string;
}

/** Single-quote a string for POSIX `sh -c`. */
export function shSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Probe whether an executable is on PATH (cross-platform). */
export function commandExists(bin: string): Promise<boolean> {
  return new Promise((res) => {
    const probe = process.platform === "win32" ? "where" : "which";
    const child = spawn(probe, [bin], { windowsHide: true, env: sanitizeEnv(process.env) });
    child.on("error", () => res(false));
    child.on("close", (code) => res(code === 0));
  });
}

/** Default no-op sandbox: passes commands through unchanged. */
class NoopSandbox implements Sandbox {
  readonly id = "noop";
  constructor(readonly required = false) {}
  async available(): Promise<boolean> {
    return !this.required;
  }
  wrap(input: WrapInput): string {
    return input.command;
  }
  describe(): string {
    return "no OS sandbox (jail + permission engine only)";
  }
}

/** Linux: bubblewrap — confine fs/namespaces to cwd + optionally drop network. */
class LinuxSandbox implements Sandbox {
  readonly id = "linux";
  private bin: string | null = null;
  private probe: Promise<boolean> | null = null;

  constructor(readonly required = false) {}

  async available(): Promise<boolean> {
    this.probe ??= (async () => {
      this.bin = await resolveTrustedExecutable([
        "/usr/bin/bwrap",
        "/bin/bwrap",
        "/usr/local/bin/bwrap",
      ]);
      if (this.bin && !(await probePinnedExecutable(this.bin, [
        "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net",
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind-try", "/lib64", "/lib64",
        "--proc", "/proc", "--dev", "/dev",
        "--dir", "/tmp", "--chdir", "/tmp", "--die-with-parent",
        "--", "/bin/true",
      ]))) this.bin = null;
      return this.bin !== null;
    })();
    return this.probe;
  }

  wrap(input: WrapInput): string {
    if (!this.bin) return input.command;
    const inner = `/bin/sh -c ${shSingleQuote(input.command)}`;
    const net = input.allowNetwork ? [] : ["--unshare-net"];
    const args = [
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      ...net,
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind-try", "/etc", "/etc",
      "--proc", "/proc",
      "--dev", "/dev",
      "--bind", input.cwd, input.cwd,
      "--chdir", input.cwd,
      "--die-with-parent",
      "--",
    ];
    return `${shSingleQuote(this.bin)} ${args.map(shSingleQuote).join(" ")} ${inner}`;
  }

  describe(): string {
    return this.bin
      ? "linux sandbox via bwrap (fs→cwd, PID/IPC isolated, network denied)"
      : "linux sandbox unavailable (install bubblewrap)";
  }
}

/** macOS: sandbox-exec with a deny-by-default profile, write-scoped to cwd. */
class MacSandbox implements Sandbox {
  readonly id = "macos";
  private bin: string | null = null;
  private probe: Promise<boolean> | null = null;

  constructor(readonly required = false) {}

  async available(): Promise<boolean> {
    this.probe ??= (async () => {
      this.bin = await resolveTrustedExecutable(["/usr/bin/sandbox-exec"]);
      if (this.bin && !(await probePinnedExecutable(
        this.bin,
        ["-p", "(version 1) (allow default)", "/usr/bin/true"],
      ))) this.bin = null;
      return this.bin !== null;
    })();
    const available = await this.probe;
    // sandbox-exec can provide best-effort write isolation, but this profile
    // cannot protect HOME/SSH reads strongly enough for strict-required.
    return this.required ? false : available;
  }

  profile(input: WrapInput): string {
    const net = input.allowNetwork ? "(allow network*)" : "(deny network*)";
    return [
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      `(allow file-write* (subpath ${JSON.stringify(input.cwd)}))`,
      "(allow file-write* (subpath \"/private/tmp\") (subpath \"/tmp\"))",
      net,
    ].join(" ");
  }

  wrap(input: WrapInput): string {
    if (!this.bin) return input.command;
    return `${shSingleQuote(this.bin)} -p ${shSingleQuote(this.profile(input))} /bin/sh -c ${shSingleQuote(input.command)}`;
  }

  describe(): string {
    if (this.required) return "macOS strict-required unavailable (sandbox-exec cannot safely confine file reads)";
    return this.bin
      ? "macOS sandbox via sandbox-exec (write→cwd, network denied; reads are not confined)"
      : "macOS sandbox unavailable (sandbox-exec missing)";
  }
}

/** Windows: no reliable userland sandbox without a native addon — documented. */
class WindowsSandbox implements Sandbox {
  readonly id = "windows";
  constructor(readonly required = false) {}
  async available(): Promise<boolean> {
    return false;
  }
  wrap(input: WrapInput): string {
    return input.command;
  }
  describe(): string {
    return "Windows strict sandbox unavailable in userland (residual risk; relies on jail + permission engine)";
  }
}

function platformSandbox(required = false): Sandbox {
  switch (process.platform) {
    case "linux":
      return new LinuxSandbox(required);
    case "darwin":
      return new MacSandbox(required);
    case "win32":
      return new WindowsSandbox(required);
    default:
      return new NoopSandbox(required);
  }
}

/**
 * Create a sandbox for the given mode. `off` (default) → noop passthrough.
 * `strict` → best-effort platform primitive (may report unavailable).
 */
export function createSandbox(mode: SandboxMode = "off"): Sandbox {
  return mode === "strict" || mode === "strict-required"
    ? platformSandbox(mode === "strict-required")
    : new NoopSandbox();
}

/** Resolve a primitive only from fixed system locations, never agent PATH. */
async function resolveTrustedExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const resolved = await realpath(candidate);
      const metadata = await stat(resolved);
      if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) continue;
      await access(resolved, fsConstants.X_OK);
      return resolved;
    } catch {
      // Try the next fixed system location.
    }
  }
  return null;
}

function probePinnedExecutable(
  command: string,
  args: readonly string[],
  timeoutMs = 3_000,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: "ignore",
      env: sanitizeEnv(process.env),
    });
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

/**
 * Convenience: wrap only when the sandbox can actually enforce isolation.
 * Returns `{ command, sandboxed, note }` — `command` is safe to spawn as-is.
 */
export async function maybeSandbox(
  sandbox: Sandbox,
  input: WrapInput,
  options: { required?: boolean } = {},
): Promise<{ command: string; sandboxed: boolean; note: string }> {
  const required = sandbox.required === true || options.required === true;
  if (sandbox.id === "noop") {
    const note = sandbox.describe();
    if (required) throw new SandboxUnavailableError(note);
    return { command: input.command, sandboxed: false, note };
  }
  const ok = await sandbox.available();
  const note = sandbox.describe();
  if (!ok && required) throw new SandboxUnavailableError(note);
  return ok
    ? { command: sandbox.wrap(input), sandboxed: true, note }
    : { command: input.command, sandboxed: false, note };
}
